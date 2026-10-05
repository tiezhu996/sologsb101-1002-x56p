/**
 * /migration 整箱改挂工作台
 * 电站扩容、旧逆变器退运：冻结两端录入与派工 → 对账箱内组串 → 整箱搬迁到新逆变器 →
 * 重算源/目标离散率与可疑标记 → 未完成处置单按新归属重派、已复测结论保留原基准。
 * 写入失败按箱回滚设备归属、保留已确认范围，重试不重复搬迁。
 */
import { useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Popconfirm,
  Row,
  Select,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  LockOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { useMigrationStore } from '../stores/migrationStore';
import { useDeviceStore } from '../stores/deviceStore';
import { useDisposalStore } from '../stores/disposalStore';
import { reconcileBoxes } from '../utils/migration';
import {
  BOX_MIGRATION_STATE_LABEL,
  MIGRATION_STATE_LABEL,
  migrationProgress,
  type BoxReconcileResult,
  type MigrationDraft,
  type MigrationRow,
} from '../types/migration';
import { groupKeyOf } from '../utils/discrete';
import StatBadge from '../components/common/StatBadge';
import FreezeBanner from '../components/common/FreezeBanner';
import EmptyPanel from '../components/common/EmptyPanel';

interface SourceBox {
  inverterId: string;
  combinerBox: string;
  stringIds: string[];
}

interface FreezeFormValues {
  operator: string;
  reason: string;
}

const STATE_COLOR = {
  draft: 'default',
  migrated: 'success',
  failed: 'error',
} as const;

export default function MigrationWorkbench() {
  const { message } = AntdApp.useApp();

  const frozen = useMigrationStore((state) => state.freeze?.frozen === true);
  const freezeInfo = useMigrationStore((state) => state.freeze);
  const migrations = useMigrationStore((state) => state.migrations);
  const freezeBothEnds = useMigrationStore((state) => state.freezeBothEnds);
  const unfreeze = useMigrationStore((state) => state.unfreeze);
  const createDraft = useMigrationStore((state) => state.createDraft);
  const run = useMigrationStore((state) => state.run);
  const deleteMigration = useMigrationStore((state) => state.deleteMigration);

  const inverters = useDeviceStore((state) => state.inverters);
  const arrays = useDeviceStore((state) => state.arrays);
  const plants = useDeviceStore((state) => state.plants);
  const strings = useDeviceStore((state) => state.strings);
  const disposals = useDisposalStore((state) => state.disposals);

  const [freezeForm] = Form.useForm<FreezeFormValues>();
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [sourceInverterId, setSourceInverterId] = useState<string>('');
  const [selectedBoxes, setSelectedBoxes] = useState<string[]>([]);
  const [targetInverterId, setTargetInverterId] = useState<string>('');
  const [targetBoxOverrides, setTargetBoxOverrides] = useState<Record<string, string>>({});
  const [name, setName] = useState('扩容改挂');
  const [reconcile, setReconcile] = useState<BoxReconcileResult[]>([]);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [detail, setDetail] = useState<MigrationRow | null>(null);

  const inverterName = (id: string): string => {
    const inverter = inverters.find((item) => item.id === id);
    if (!inverter) return '已删除逆变器';
    const array = arrays.find((item) => item.id === inverter.arrayId);
    const plant = array ? plants.find((item) => item.id === array.plantId) : undefined;
    return `${plant?.name ?? '-'} / ${array?.code ?? '-'} / ${inverter.model}`;
  };

  /** 可选源逆变器：按其下挂接组串分组出汇流箱 */
  const sourceBoxes = useMemo<SourceBox[]>(() => {
    const map = new Map<string, SourceBox>();
    for (const str of strings) {
      if (sourceInverterId && str.inverterId !== sourceInverterId) continue;
      const key = groupKeyOf(str);
      const box = map.get(key);
      if (box) box.stringIds.push(str.id);
      else map.set(key, { inverterId: str.inverterId, combinerBox: str.combinerBox, stringIds: [str.id] });
    }
    return [...map.values()].sort((a, b) =>
      `${a.inverterId}${a.combinerBox}`.localeCompare(`${b.inverterId}${b.combinerBox}`),
    );
  }, [strings, sourceInverterId]);

  const targetOptions = useMemo(
    () =>
      inverters
        .filter((item) => item.id !== sourceInverterId)
        .map((item) => ({ label: inverterName(item.id), value: item.id })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inverters, arrays, plants, sourceInverterId],
  );

  const selectedSourceBoxes = useMemo(
    () => sourceBoxes.filter((box) => selectedBoxes.includes(groupKeyOf({ inverterId: box.inverterId, combinerBox: box.combinerBox }))),
    [sourceBoxes, selectedBoxes],
  );

  const openFreeze = (): void => {
    freezeForm.resetFields();
    freezeForm.setFieldsValue({ operator: '李文波', reason: '旧逆变器退运，整箱组串改挂至新设备' });
    setFreezeOpen(true);
  };

  const submitFreeze = async (): Promise<void> => {
    const values = await freezeForm.validateFields();
    await freezeBothEnds(values);
    message.success('已冻结设备台账与采集处置两端录入、派工');
    setFreezeOpen(false);
    setBuilderOpen(true);
  };

  const openBuilder = async (): Promise<void> => {
    setBuilderOpen(true);
    setSourceInverterId(inverters[0]?.id ?? '');
    setSelectedBoxes([]);
    setTargetInverterId('');
    setTargetBoxOverrides({});
    setReconcile([]);
  };

  /** 搬迁前对账：核对选中整箱的箱内组串在两端归属一致 */
  const runReconcile = async (): Promise<void> => {
    if (selectedSourceBoxes.length === 0) {
      message.warning('请先勾选要整箱改挂的汇流箱');
      return;
    }
    setChecking(true);
    try {
      const results = await reconcileBoxes(
        selectedSourceBoxes.map((box) => ({
          sourceInverterId: box.inverterId,
          sourceCombinerBox: box.combinerBox,
        })),
      );
      setReconcile(results);
      const inconsistent = results.filter((item) => !item.consistent);
      if (inconsistent.length > 0) {
        message.error(`对账发现 ${inconsistent.length} 个箱存在两端归属不一致（空箱或悬空引用），请先处理`);
      } else {
        message.success(`对账一致：${results.length} 个整箱、共 ${results.reduce((s, r) => s + r.ledgerStringIds.length, 0)} 串可搬迁`);
      }
    } finally {
      setChecking(false);
    }
  };

  const reconcileConsistent = reconcile.length > 0 && reconcile.every((item) => item.consistent);

  const submitMigration = async (): Promise<void> => {
    if (!targetInverterId) {
      message.warning('请选择目标新逆变器');
      return;
    }
    if (!reconcileConsistent) {
      message.warning('请先完成箱内组串对账且全部一致');
      return;
    }
    const targetInverter = inverters.find((item) => item.id === targetInverterId);
    if (!targetInverter) return;
    // 目标箱冲突校验：目标逆变器上已存在同名箱，且不在本次搬迁来源中，要求改名，避免混入非本批组串
    const existingTargetBoxes = new Set(
      strings.filter((item) => item.inverterId === targetInverterId).map((item) => item.combinerBox),
    );
    const draftBoxes = selectedSourceBoxes.map((box) => {
      const key = groupKeyOf({ inverterId: box.inverterId, combinerBox: box.combinerBox });
      return {
        sourceInverterId: box.inverterId,
        sourceCombinerBox: box.combinerBox,
        targetInverterId,
        targetCombinerBox: targetBoxOverrides[key] ?? box.combinerBox,
        stringIds: box.stringIds,
      };
    });
    const conflicts = draftBoxes.filter(
      (box) => existingTargetBoxes.has(box.targetCombinerBox),
    );
    if (conflicts.length > 0) {
      message.warning(`目标逆变器已存在汇流箱 ${conflicts.map((c) => c.targetCombinerBox).join('、')}，请改名后再提交`);
      return;
    }
    setSubmitting(true);
    try {
      const draft: MigrationDraft = {
        name: name.trim() || '扩容改挂',
        operator: freezeInfo?.operator ?? '',
        sourceInverterIds: [...new Set(draftBoxes.map((box) => box.sourceInverterId))],
        targetInverterIds: [targetInverterId],
        boxes: draftBoxes,
      };
      const created = await createDraft(draft);
      message.success('搬迁单已创建，已确认范围已冻结保留');
      setBuilderOpen(false);
      setDetail(created);
    } finally {
      setSubmitting(false);
    }
  };

  const doRun = async (migration: MigrationRow): Promise<void> => {
    const result = await run(migration.id);
    if (result.state === 'migrated') {
      message.success(
        `改挂完成：${result.movedBoxes} 箱 / ${result.movedStrings} 串；重派处置单 ${result.redispatchedDisposals} 单，保留复测结论 ${result.retainedRetests} 单；重算离散率 ${result.recalcedGroups} 个分组，已自动解冻`,
      );
    } else {
      message.error(
        `部分箱搬迁失败：设备归属已回滚，已确认范围保留，可重试（不重复搬迁已成功箱）。${result.error ?? ''}`,
      );
    }
    setDetail(null);
  };

  const hasMigration = migrations.length > 0;
  const anyMigrated = migrations.some((m) => m.state === 'migrated');
  const stepIndex = frozen ? (anyMigrated ? 3 : 2) : hasMigration ? 3 : 1;

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <Typography.Title level={4} className="gb-page-title">
            整箱改挂（旧逆变器退运）
          </Typography.Title>
          <Typography.Text type="secondary">
            冻结两端录入与派工 → 对账箱内组串 → 整箱搬迁到新设备 → 重算两端离散率与可疑标记；未完成处置单按新归属重派，已复测结论保留原基准。
          </Typography.Text>
        </div>
        <Space wrap>
          {frozen ? (
            <Popconfirm
              title="解除冻结？"
              description="已确认的搬迁范围与搬迁单会保留；解除后两端可继续录入。"
              okText="解除冻结"
              cancelText="取消"
              onConfirm={async () => {
                await unfreeze('人工解除冻结');
                message.success('已解除冻结');
              }}
            >
              <Button icon={<UnlockOutlined />}>解除冻结</Button>
            </Popconfirm>
          ) : (
            <Button type="primary" danger icon={<LockOutlined />} onClick={openFreeze}>
              开始冻结并改挂
            </Button>
          )}
        </Space>
      </div>

      <FreezeBanner scope="设备台账录入 / 采集录入 / 处置派工" showEntry={false} />

      <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: 16 } }}>
        <Steps
          size="small"
          current={stepIndex}
          items={[
            { title: '冻结两端', icon: <LockOutlined />, description: frozen ? '冻结中' : '待冻结' },
            { title: '箱内对账', description: '台账 ↔ 采集处置' },
            { title: '整箱搬迁', description: '失败按箱回滚、可重试' },
            { title: '重算与重派', description: '离散率/可疑标记重算' },
          ]}
        />
      </Card>

      <div className="gb-stat-grid">
        <StatBadge title="冻结状态" value={frozen ? '冻结中' : '正常'} color={frozen ? '#d46b08' : '#237804'} />
        <StatBadge title="搬迁单总数" value={migrations.length} suffix="张" color="#1668dc" />
        <StatBadge
          title="已完成改挂"
          value={migrations.filter((m) => m.state === 'migrated').length}
          suffix="张"
          color="#0f7b6c"
        />
        <StatBadge
          title="待重试（部分失败）"
          value={migrations.filter((m) => m.state === 'failed').length}
          suffix="张"
          color="#a8071a"
        />
      </div>

      {frozen ? (
        <Card size="small" style={{ marginTop: 12 }} title="改挂范围（冻结期间可操作）" styles={{ body: { padding: 12 } }}>
          <Space wrap>
            <Button type="primary" icon={<SafetyCertificateOutlined />} onClick={() => void openBuilder()}>
              选择整箱并对账
            </Button>
            {freezeInfo?.migrationId ? (
              <Tag color="blue">关联搬迁单：{freezeInfo.migrationId.slice(0, 10)}…</Tag>
            ) : null}
            <span className="gb-hint">{freezeInfo?.reason}</span>
          </Space>
        </Card>
      ) : null}

      <Card size="small" style={{ marginTop: 12 }} title="搬迁单" styles={{ body: { padding: 12 } }}>
        {migrations.length === 0 ? (
          <EmptyPanel
            title="暂无搬迁单"
            description="点击右上角「开始冻结并改挂」：先冻结两端，再按汇流箱整箱对账与搬迁。"
            createLabel="开始冻结并改挂"
            onCreate={openFreeze}
          />
        ) : (
          <Table<MigrationRow>
            rowKey="id"
            size="small"
            dataSource={migrations}
            pagination={{ pageSize: 8, size: 'small' }}
            scroll={{ x: 1000 }}
            columns={[
              { title: '搬迁单', dataIndex: 'name', width: 180 },
              {
                title: '状态',
                dataIndex: 'state',
                width: 110,
                render: (value: MigrationRow['state']) => (
                  <Tag color={STATE_COLOR[value]}>{MIGRATION_STATE_LABEL[value]}</Tag>
                ),
              },
              {
                title: '源 → 目标',
                width: 300,
                render: (_, row) => (
                  <Space direction="vertical" size={2}>
                    <span className="gb-hint">退运：{row.sourceInverterIds.map(inverterName).join('、')}</span>
                    <span>新设备：{row.targetInverterIds.map(inverterName).join('、')}</span>
                  </Space>
                ),
              },
              {
                title: '整箱进度',
                width: 160,
                render: (_, row) => {
                  const p = migrationProgress(row);
                  return (
                    <Space size={4} wrap>
                      <Tag color="success">已搬 {p.migrated}/{p.total}</Tag>
                      {p.failed > 0 ? <Tag color="error">失败 {p.failed}</Tag> : null}
                      {p.pending > 0 ? <Tag>待搬 {p.pending}</Tag> : null}
                    </Space>
                  );
                },
              },
              { title: '组串', width: 90, render: (_, row) => `${migrationProgress(row).stringMigrated}/${migrationProgress(row).stringTotal}` },
              { title: '操作人', dataIndex: 'operator', width: 90 },
              {
                title: '操作',
                width: 250,
                fixed: 'right',
                render: (_, row) => (
                  <Space size={2}>
                    <Button size="small" type="link" onClick={() => setDetail(row)}>
                      明细
                    </Button>
                    {row.state !== 'migrated' ? (
                      <Popconfirm
                        title={row.state === 'failed' ? '重试失败箱？' : '执行整箱搬迁？'}
                        description="已成功的箱不重复搬迁；失败箱设备归属已回滚。"
                        okText="执行"
                        cancelText="取消"
                        onConfirm={() => void doRun(row)}
                      >
                        <Button size="small" type="link" icon={row.state === 'failed' ? <ReloadOutlined /> : <PlayCircleOutlined />}>
                          {row.state === 'failed' ? '重试' : '执行搬迁'}
                        </Button>
                      </Popconfirm>
                    ) : (
                      <Tag icon={<CheckCircleOutlined />} color="success">
                        已完成
                      </Tag>
                    )}
                    <Popconfirm
                      title="删除该搬迁单记录？"
                      description="仅删除搬迁单留档，不回滚已完成的组串归属。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={async () => {
                        await deleteMigration(row.id);
                        message.success('搬迁单已删除');
                      }}
                    >
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>

      {/* 冻结确认 */}
      <Drawer
        title="冻结两端录入与派工"
        width={420}
        open={freezeOpen}
        onClose={() => setFreezeOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setFreezeOpen(false)}>取消</Button>
            <Button type="primary" danger onClick={() => void submitFreeze()}>
              确认冻结
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          冻结后：设备台账的逆变器/组串增删改、采集记录的录入与删除、处置单的新建与派工全部暂停；
          复测回填保留可用（不改归属、保留原基准结论）。搬迁全部完成后自动解冻。
        </Typography.Paragraph>
        <Form form={freezeForm} layout="vertical">
          <Form.Item name="operator" label="操作人" rules={[{ required: true, message: '请输入操作人' }]}>
            <Input placeholder="如：李文波" />
          </Form.Item>
          <Form.Item name="reason" label="冻结原因" rules={[{ required: true, message: '请输入冻结原因' }]}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Drawer>

      {/* 选箱 + 对账 + 建单 */}
      <Drawer
        title="选择整箱并对账"
        width={920}
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        extra={
          <Space>
            <Button onClick={() => setBuilderOpen(false)}>取消</Button>
            <Button
              type="primary"
              loading={submitting}
              disabled={!reconcileConsistent || !targetInverterId}
              onClick={() => void submitMigration()}
            >
              确认范围并建搬迁单
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Row gutter={12}>
            <Col span={12}>
              <Typography.Text strong>退运源逆变器</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 6 }}
                showSearch
                optionFilterProp="label"
                value={sourceInverterId || undefined}
                onChange={(value) => {
                  setSourceInverterId(value);
                  setSelectedBoxes([]);
                  setReconcile([]);
                }}
                options={inverters.map((item) => ({ label: inverterName(item.id), value: item.id }))}
              />
            </Col>
            <Col span={12}>
              <Typography.Text strong>目标新逆变器</Typography.Text>
              <Select
                style={{ width: '100%', marginTop: 6 }}
                showSearch
                optionFilterProp="label"
                placeholder="选择扩容后的新设备"
                value={targetInverterId || undefined}
                onChange={setTargetInverterId}
                options={targetOptions}
              />
            </Col>
          </Row>

          <Card size="small" title="源逆变器下的汇流箱（整箱勾选，不拆串）" styles={{ body: { padding: 8 } }}>
            <Table<SourceBox>
              rowKey={(box) => groupKeyOf({ inverterId: box.inverterId, combinerBox: box.combinerBox })}
              size="small"
              pagination={false}
              dataSource={sourceBoxes}
              rowSelection={{
                selectedRowKeys: selectedBoxes,
                onChange: (keys) => {
                  setSelectedBoxes(keys.map(String));
                  setReconcile([]);
                },
              }}
              columns={[
                { title: '汇流箱', dataIndex: 'combinerBox', width: 120 },
                { title: '组串数', width: 90, render: (_, row) => row.stringIds.length },
                {
                  title: '目标箱编号（可改）',
                  render: (_, row) => {
                    const key = groupKeyOf({ inverterId: row.inverterId, combinerBox: row.combinerBox });
                    return (
                      <Input
                        size="small"
                        style={{ width: 140 }}
                        placeholder={row.combinerBox}
                        value={targetBoxOverrides[key] ?? row.combinerBox}
                        onChange={(e) =>
                          setTargetBoxOverrides((prev) => ({ ...prev, [key]: e.target.value || row.combinerBox }))
                        }
                      />
                    );
                  },
                },
              ]}
            />
          </Card>

          <Space>
            <Button icon={<SafetyCertificateOutlined />} loading={checking} onClick={() => void runReconcile()}>
              核对箱内组串（两端对账）
            </Button>
            {reconcile.length > 0 ? (
              reconcileConsistent ? (
                <Tag color="success">对账一致，可建单</Tag>
              ) : (
                <Tag color="error">对账不一致，请处理后再搬</Tag>
              )
            ) : null}
          </Space>

          {reconcile.length > 0 ? (
            <Card size="small" title="对账结果" styles={{ body: { padding: 8 } }}>
              <Table<BoxReconcileResult>
                rowKey={(r) => `${r.sourceInverterId}::${r.sourceCombinerBox}`}
                size="small"
                pagination={false}
                dataSource={reconcile}
                columns={[
                  { title: '汇流箱', dataIndex: 'sourceCombinerBox', width: 110 },
                  { title: '台账组串', dataIndex: 'ledgerStringIds', width: 90, render: (v: string[]) => v.length },
                  { title: '有采集', dataIndex: 'sampledCount', width: 80 },
                  { title: '未完成处置单', dataIndex: 'openDisposalCount', width: 110 },
                  {
                    title: '两端一致',
                    width: 100,
                    render: (_, row) =>
                      row.consistent ? <Tag color="success">一致</Tag> : <Tag color="error">不一致</Tag>,
                  },
                  {
                    title: '悬空引用',
                    render: (_, row) =>
                      row.orphanStringIds.length === 0 ? (
                        <span className="gb-hint">无</span>
                      ) : (
                        <Tag color="error">{row.orphanStringIds.length} 条悬空</Tag>
                      ),
                  },
                ]}
              />
            </Card>
          ) : null}

          <Form layout="inline">
            <Form.Item label="搬迁单名称">
              <Input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 240 }} />
            </Form.Item>
          </Form>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            建单后未完成处置单（待处理/已派工）将在搬迁时回到「待处理」按新归属重派；已复测单的复测电流与基准原样保留。
          </Typography.Paragraph>
        </Space>
      </Drawer>

      {/* 搬迁单明细 */}
      <Drawer
        title={detail ? `搬迁单明细 · ${detail.name}` : '搬迁单明细'}
        width={860}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="状态">
                <Tag color={STATE_COLOR[detail.state]}>{MIGRATION_STATE_LABEL[detail.state]}</Tag>
                {detail.lastError ? <Typography.Text type="danger"> {detail.lastError}</Typography.Text> : null}
              </Descriptions.Item>
              <Descriptions.Item label="退运源逆变器">{detail.sourceInverterIds.map(inverterName).join('、')}</Descriptions.Item>
              <Descriptions.Item label="目标新逆变器">{detail.targetInverterIds.map(inverterName).join('、')}</Descriptions.Item>
              <Descriptions.Item label="操作人">{detail.operator}</Descriptions.Item>
            </Descriptions>
            <Table
              rowKey={(box) => `${box.sourceInverterId}::${box.sourceCombinerBox}`}
              size="small"
              pagination={false}
              dataSource={detail.boxes}
              columns={[
                {
                  title: '源汇流箱',
                  render: (_, box) => `${box.sourceCombinerBox}（${inverterName(box.sourceInverterId)}）`,
                },
                { title: '组串', dataIndex: 'stringIds', width: 80, render: (v: string[]) => v.length },
                {
                  title: '目标',
                  width: 200,
                  render: (_, box) => `${inverterName(box.targetInverterId)} / ${box.targetCombinerBox}`,
                },
                {
                  title: '状态',
                  width: 110,
                  render: (_, box) => (
                    <Space direction="vertical" size={0}>
                      <Tag color={box.state === 'migrated' ? 'success' : box.state === 'failed' ? 'error' : 'default'}>
                        {BOX_MIGRATION_STATE_LABEL[box.state]}
                      </Tag>
                      {box.error ? <Typography.Text type="danger" style={{ fontSize: 12 }}>{box.error}</Typography.Text> : null}
                    </Space>
                  ),
                },
                {
                  title: '未完成处置单',
                  width: 110,
                  render: (_, box) => {
                    const ids = new Set(box.stringIds);
                    const open = disposals.filter((d) => ids.has(d.stringId) && d.state !== 'retested').length;
                    const retested = disposals.filter((d) => ids.has(d.stringId) && d.state === 'retested').length;
                    return (
                      <Space size={4} wrap>
                        <Tag color="orange">{open} 待重派</Tag>
                        <Tag color="blue">{retested} 保留结论</Tag>
                      </Space>
                    );
                  },
                },
              ]}
            />
            {detail.state !== 'migrated' ? (
              <Popconfirm
                title={detail.state === 'failed' ? '重试失败箱？' : '执行整箱搬迁？'}
                description="单箱独立事务：失败自动回滚设备归属；已成功箱不重复搬迁。"
                okText="执行"
                cancelText="取消"
                onConfirm={() => void doRun(detail)}
              >
                <Button type="primary" icon={detail.state === 'failed' ? <ReloadOutlined /> : <PlayCircleOutlined />}>
                  {detail.state === 'failed' ? '重试失败箱' : '执行搬迁'}
                </Button>
              </Popconfirm>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="全部整箱已改挂，两端离散率与可疑标记已重算，冻结已解除" />
            )}
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
