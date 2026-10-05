/**
 * /inverters 三级设备台账
 * 逆变器 / 汇流箱 / 组串三级树形台账，可批量新增组串；消费 Array、Inverter、String 与 <FilterBar>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tree,
  Typography,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  ApartmentOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SwapOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useDeviceStore } from '../stores/deviceStore';
import { usePlantStore } from '../stores/plantStore';
import { useSampleStore } from '../stores/sampleStore';
import { useRelocationStore } from '../stores/relocationStore';
import type { InverterDraft } from '../types/inverter';
import { inverterHealth, serviceYears, stringsPerMppt } from '../types/inverter';
import type { BatchStringDraft, StringDraft } from '../types/string';
import type { RelocationDraft, RelocationPlan } from '../types/relocation';
import { expectedVoc } from '../types/string';
import type { InverterLedgerRow } from '../types/inverter';
import type { InverterRow, StringRow } from '../utils/db';
import { formatCurrent, formatVoltage, share } from '../utils/unit';
import DiscreteBadge from '../components/common/DiscreteBadge';
import EmptyPanel from '../components/common/EmptyPanel';
import StatBadge from '../components/common/StatBadge';
import FilterBar, { useKeywordFilter } from '../components/common/FilterBar';
import { useFilterValues } from '../components/common/FilterBar';

interface InverterFormValues {
  arrayId: string;
  model: string;
  ratedKw: number;
  mpptCount: number;
  commissionDate: dayjs.Dayjs;
}

interface StringFormValues {
  combinerBox: string;
  code: string;
  moduleModel: string;
  seriesCount: number;
}

interface RelocationFormValues {
  sourceCombinerBox: string;
  targetInverterId: string;
  targetCombinerBox: string;
  reason: string;
}

export default function DeviceLedger() {
  const { message } = AntdApp.useApp();
  const plants = useDeviceStore((state) => state.plants);
  const arrays = useDeviceStore((state) => state.arrays);
  const inverters = useDeviceStore((state) => state.inverters);
  const strings = useDeviceStore((state) => state.strings);
  const stringAlarmRates = useDeviceStore((state) => state.stringAlarmRates);
  const expandedInverterIds = useDeviceStore((state) => state.expandedInverterIds);
  const toggleExpand = useDeviceStore((state) => state.toggleExpand);
  const expandAll = useDeviceStore((state) => state.expandAll);
  const collapseAll = useDeviceStore((state) => state.collapseAll);
  const createInverter = useDeviceStore((state) => state.createInverter);
  const updateInverter = useDeviceStore((state) => state.updateInverter);
  const deleteInverter = useDeviceStore((state) => state.deleteInverter);
  const createString = useDeviceStore((state) => state.createString);
  const updateString = useDeviceStore((state) => state.updateString);
  const deleteString = useDeviceStore((state) => state.deleteString);
  const batchCreateStrings = useDeviceStore((state) => state.batchCreateStrings);
  const ledgerRows = useDeviceStore((state) => state.ledgerRows);

  const activePlantId = usePlantStore((state) => state.activePlantId);
  const stats = useSampleStore((state) => state.stats);
  const thresholds = useSampleStore((state) => state.thresholds);
  const remarkAfterRelocation = useSampleStore((state) => state.remarkAfterRelocation);
  const activeRelocation = useRelocationStore((state) => state.activePlan);
  const freezeRelocation = useRelocationStore((state) => state.freeze);
  const executeRelocation = useRelocationStore((state) => state.execute);
  const cancelRelocation = useRelocationStore((state) => state.cancel);

  const keyword = useKeywordFilter();
  const filters = useFilterValues(['plant', 'state']);
  const [inverterForm] = Form.useForm<InverterFormValues>();
  const [stringForm] = Form.useForm<StringFormValues>();
  const [batchForm] = Form.useForm<{ combinerBox: string; moduleModel: string; seriesCount: number; startSeq: number; count: number }>();
  const [relocationForm] = Form.useForm<RelocationFormValues>();
  const [relocationModal, setRelocationModal] = useState<{ open: boolean; sourceInverterId: string; sourceCombinerBox: string }>({
    open: false,
    sourceInverterId: '',
    sourceCombinerBox: '',
  });
  const [frozenRelocationPlan, setFrozenRelocationPlan] = useState<RelocationPlan | null>(null);
  const [relocationSubmitting, setRelocationSubmitting] = useState(false);
  const [inverterModal, setInverterModal] = useState<{ open: boolean; editing: InverterRow | null }>({
    open: false,
    editing: null,
  });
  const [stringDrawer, setStringDrawer] = useState<{ open: boolean; inverterId: string; editing: StringRow | null }>({
    open: false,
    inverterId: '',
    editing: null,
  });

  const rows = ledgerRows();
  const plantFilter = filters.plant ?? [];
  const stateFilter = filters.state ?? [];

  const filtered = useMemo(() => {
    const lower = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (activePlantId && plantFilter.length === 0 && row.plantId !== activePlantId) return false;
      if (plantFilter.length > 0 && !plantFilter.includes(row.plantId)) return false;
      if (stateFilter.length > 0) {
        const health = inverterHealth(row.alarmStringCount, row.stringCount);
        if (!stateFilter.includes(health)) return false;
      }
      if (lower) {
        const haystack = [row.model, row.arrayCode, row.plantName, ...row.boxCodes].join(' ').toLowerCase();
        if (!haystack.includes(lower)) return false;
      }
      return true;
    });
  }, [rows, keyword, plantFilter, stateFilter, activePlantId]);

  const totals = useMemo(() => {
    const ratedSum = filtered.reduce((sum, row) => sum + row.ratedKw, 0);
    const stringCount = filtered.reduce((sum, row) => sum + row.stringCount, 0);
    const alarm = filtered.reduce((sum, row) => sum + row.alarmStringCount, 0);
    return {
      inverters: filtered.length,
      ratedSum,
      stringCount,
      alarm,
      alarmShare: share(alarm, stringCount),
    };
  }, [filtered]);

  /** 树数据：电站 → 方阵 → 逆变器 → 汇流箱 → 组串 */
  const treeData: DataNode[] = useMemo(() => {
    const plantNodes = plants.map((plant) => {
      const plantArrays = arrays.filter((array) => array.plantId === plant.id);
      return {
        key: `plant-${plant.id}`,
        title: `${plant.name}（${plantArrays.length} 方阵）`,
        children: plantArrays.map((array) => {
          const arrayInverters = inverters.filter((inverter) => inverter.arrayId === array.id);
          return {
            key: `array-${array.id}`,
            title: `${array.code} 方阵（${arrayInverters.length} 台逆变器）`,
            children: arrayInverters.map((inverter) => {
              const owned = strings.filter((row) => row.inverterId === inverter.id);
              const boxes = [...new Set(owned.map((item) => item.combinerBox))].sort();
              return {
                key: `inverter-${inverter.id}`,
                title: `${inverter.model} · ${inverter.ratedKw}kW`,
                children: boxes.map((box) => ({
                  key: `box-${inverter.id}-${box}`,
                  title: `${box} 汇流箱（${owned.filter((item) => item.combinerBox === box).length} 串）`,
                  children: owned
                    .filter((item) => item.combinerBox === box)
                    .map((item) => ({
                      key: `string-${item.id}`,
                      title: `${item.code} · ${item.moduleModel} · ${item.seriesCount} 串接`,
                    })),
                })),
              };
            }),
          };
        }),
      };
    });
    return plantNodes;
  }, [plants, arrays, inverters, strings]);

  const openInverterModal = (editing: InverterLedgerRow | null): void => {
    setInverterModal({ open: true, editing });
    if (editing) {
      inverterForm.setFieldsValue({
        arrayId: editing.arrayId,
        model: editing.model,
        ratedKw: editing.ratedKw,
        mpptCount: editing.mpptCount,
        commissionDate: dayjs(editing.commissionDate),
      });
    } else {
      inverterForm.resetFields();
      inverterForm.setFieldsValue({
        arrayId: arrays.find((array) => array.plantId === activePlantId)?.id ?? arrays[0]?.id,
        model: '',
        ratedKw: 100,
        mpptCount: 8,
        commissionDate: dayjs(),
      });
    }
  };

  const submitInverter = async (): Promise<void> => {
    const values = await inverterForm.validateFields();
    const draft: InverterDraft = {
      arrayId: values.arrayId,
      model: values.model,
      ratedKw: values.ratedKw,
      mpptCount: values.mpptCount,
      commissionDate: values.commissionDate.format('YYYY-MM-DD'),
    };
    if (inverterModal.editing) {
      await updateInverter(inverterModal.editing.id, draft);
      message.success('逆变器已更新');
    } else {
      const created = await createInverter(draft);
      message.success('逆变器已新增，可继续挂接组串');
      setInverterModal({ open: false, editing: null });
      setStringDrawer({ open: true, inverterId: created.id, editing: null });
      return;
    }
    setInverterModal({ open: false, editing: null });
  };

  const openStringDrawer = (inverterId: string, editing: StringRow | null): void => {
    setStringDrawer({ open: true, inverterId, editing });
    if (editing) {
      stringForm.setFieldsValue({
        combinerBox: editing.combinerBox,
        code: editing.code,
        moduleModel: editing.moduleModel,
        seriesCount: editing.seriesCount,
      });
    } else {
      stringForm.resetFields();
      stringForm.setFieldsValue({
        combinerBox: 'BX-01',
        code: '',
        moduleModel: 'LR5-72HBD-545M',
        seriesCount: 26,
      });
    }
  };

  const submitString = async (): Promise<void> => {
    const values = await stringForm.validateFields();
    const draft: StringDraft = {
      inverterId: stringDrawer.inverterId,
      combinerBox: values.combinerBox,
      code: values.code,
      moduleModel: values.moduleModel,
      seriesCount: values.seriesCount,
    };
    if (stringDrawer.editing) {
      await updateString(stringDrawer.editing.id, draft);
      message.success('组串已更新');
    } else {
      await createString(draft);
      message.success('组串已新增');
    }
    setStringDrawer((prev) => ({ ...prev, editing: null }));
    stringForm.resetFields();
  };

  const submitBatch = async (): Promise<void> => {
    const values = await batchForm.validateFields();
    const draft: BatchStringDraft = { inverterId: stringDrawer.inverterId, ...values };
    const created = await batchCreateStrings(draft);
    if (created === 0) message.warning('同编号组串已存在，未新增任何记录');
    else message.success(`已批量新增 ${created} 条组串`);
  };

  const drawerStrings = useMemo(
    () =>
      strings
        .filter((item) => item.inverterId === stringDrawer.inverterId)
        .sort((a, b) => `${a.combinerBox}${a.code}`.localeCompare(`${b.combinerBox}${b.code}`)),
    [strings, stringDrawer.inverterId],
  );

  const drawerInverter = inverters.find((item) => item.id === stringDrawer.inverterId) ?? null;

  const openRelocationModal = (sourceInverterId: string, sourceCombinerBox = ''): void => {
    setFrozenRelocationPlan(null);
    setRelocationModal({ open: true, sourceInverterId, sourceCombinerBox });
    relocationForm.resetFields();
    relocationForm.setFieldsValue({
      sourceCombinerBox,
      targetInverterId: inverters.find((item) => item.id !== sourceInverterId)?.id,
      targetCombinerBox: sourceCombinerBox || 'BX-01',
      reason: '旧逆变器退运，整箱组串改挂新设备',
    });
  };

  const submitRelocation = async (): Promise<void> => {
    const values = await relocationForm.validateFields();
    const draft: RelocationDraft = {
      sourceInverterId: relocationModal.sourceInverterId,
      sourceCombinerBox: values.sourceCombinerBox,
      targetInverterId: values.targetInverterId,
      targetCombinerBox: values.targetCombinerBox,
      reason: values.reason,
    };
    setRelocationSubmitting(true);
    try {
      const plan = await freezeRelocation(draft);
      setFrozenRelocationPlan(plan);
      message.success(`已冻结并核对 ${plan.stringCount} 串，请确认后搬迁`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '冻结核对失败');
    } finally {
      setRelocationSubmitting(false);
    }
  };

  const executeFrozenRelocation = async (): Promise<void> => {
    const plan = frozenRelocationPlan ?? activeRelocation;
    if (!plan) return;
    setRelocationSubmitting(true);
    try {
      const result = await executeRelocation(plan.id);
      remarkAfterRelocation(plan.confirmedStringIds, result.suspiciousStringIds);
      message.success(`已改挂 ${result.relocatedStringIds.length} 串，重派 ${result.reassignedDisposalIds.length} 张处置单`);
      setRelocationModal({ open: false, sourceInverterId: '', sourceCombinerBox: '' });
      setFrozenRelocationPlan(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '整箱改挂失败');
    } finally {
      setRelocationSubmitting(false);
    }
  };

  const retryActiveRelocation = (): void => {
    if (!activeRelocation) return;
    setFrozenRelocationPlan(activeRelocation);
    setRelocationModal({
      open: true,
      sourceInverterId: activeRelocation.sourceInverterId,
      sourceCombinerBox: activeRelocation.sourceCombinerBox,
    });
    relocationForm.setFieldsValue({
      sourceCombinerBox: activeRelocation.sourceCombinerBox,
      targetInverterId: activeRelocation.targetInverterId,
      targetCombinerBox: activeRelocation.targetCombinerBox,
      reason: activeRelocation.reason,
    });
  };

  const cancelActiveRelocation = async (): Promise<void> => {
    if (!activeRelocation) return;
    await cancelRelocation(activeRelocation.id);
    message.success('已解除冻结');
  };

  const closeRelocationModal = async (): Promise<void> => {
    const plan = frozenRelocationPlan ?? activeRelocation;
    if (plan && (plan.status === 'frozen' || plan.status === 'failed')) {
      await cancelRelocation(plan.id);
      message.info('已取消计划并解除冻结');
    }
    setFrozenRelocationPlan(null);
    setRelocationModal({ open: false, sourceInverterId: '', sourceCombinerBox: '' });
  };

  const relocationSourceRows = useMemo(() => {
    if (!activeRelocation) return [];
    const source = inverters.find((item) => item.id === activeRelocation.sourceInverterId);
    const target = inverters.find((item) => item.id === activeRelocation.targetInverterId);
    return [
      { label: '源逆变器', value: source ? `${source.model} / ${activeRelocation.sourceCombinerBox}` : activeRelocation.sourceInverterId },
      { label: '目标逆变器', value: target ? `${target.model} / ${activeRelocation.targetCombinerBox}` : activeRelocation.targetInverterId },
    ];
  }, [activeRelocation, inverters]);

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <Typography.Title level={4} className="gb-page-title">
            三级设备台账
          </Typography.Title>
          <Typography.Text type="secondary">
            逆变器 → 汇流箱 → 组串 三级结构，支持按电站/运行状态筛选与批量新增组串。
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<ApartmentOutlined />} onClick={expandAll}>
            展开全部
          </Button>
          <Button onClick={collapseAll}>收起全部</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => openInverterModal(null)}>
            新增逆变器
          </Button>
        </Space>
      </div>

      {activeRelocation ? (
        <Alert
          showIcon
          style={{ marginBottom: 12 }}
          type={activeRelocation.status === 'failed' ? 'error' : 'warning'}
          message={
            activeRelocation.status === 'failed'
              ? '改挂写入失败，设备归属已恢复；可按已确认范围重试'
              : '改挂冻结中，台账录入、采集录入与处置派工均已暂停'
          }
          description={
            <Space wrap>
              {relocationSourceRows.map((item) => (
                <Tag key={item.label}>{item.label}：{item.value}</Tag>
              ))}
              <Tag color="blue">已核对 {activeRelocation.stringCount} 串</Tag>
              <Tag color="orange">未完成单 {activeRelocation.unfinishedDisposalCount} 张</Tag>
              <Tag>已复测 {activeRelocation.retestedDisposalCount} 张保留原基准</Tag>
              {activeRelocation.status === 'failed' ? (
                <Button size="small" type="primary" loading={relocationSubmitting} onClick={retryActiveRelocation}>
                  重试（不重复搬迁）
                </Button>
              ) : null}
              <Popconfirm title="取消该冻结计划？" okText="取消冻结" cancelText="继续冻结" onConfirm={() => void cancelActiveRelocation()}>
                <Button size="small">解除冻结</Button>
              </Popconfirm>
            </Space>
          }
        />
      ) : null}

      <div className="gb-stat-grid">
        <StatBadge title="逆变器台数" value={totals.inverters} suffix="台" color="#0f7b6c" />
        <StatBadge title="额定容量合计" value={totals.ratedSum} suffix="kW" color="#1668dc" />
        <StatBadge title="组串总数" value={totals.stringCount} suffix="串" color="#08979c" />
        <StatBadge
          title="失配组串占比"
          value={totals.alarm}
          suffix={`/ ${totals.stringCount}`}
          percent={totals.alarmShare}
          color="#a8071a"
          hint="离散率 ≥ 失配阈值的组串数"
        />
      </div>

      <FilterBar
        keywordPlaceholder="按型号 / 方阵 / 汇流箱搜索"
        selects={[
          {
            key: 'plant',
            label: '电站',
            options: plants.map((item) => ({ label: item.name, value: item.id })),
            width: 210,
          },
          {
            key: 'state',
            label: '运行状态',
            options: [
              { label: '正常', value: '正常' },
              { label: '关注', value: '关注' },
              { label: '异常', value: '异常' },
            ],
            width: 170,
          },
        ]}
        resultCount={filtered.length}
        countUnit="台逆变器"
      />

      <Row gutter={14} style={{ marginTop: 14 }}>
        <Col xs={24} xl={15}>
          <Card size="small" title="逆变器台账" styles={{ body: { padding: 12 } }}>
            {filtered.length === 0 ? (
              <EmptyPanel
                title="暂无逆变器"
                description="先建电站与方阵，再登记逆变器并挂接组串。"
                createLabel="新增逆变器"
                onCreate={() => openInverterModal(null)}
              />
            ) : (
              <Table<InverterLedgerRow>
                rowKey="id"
                size="small"
                dataSource={filtered}
                pagination={{ pageSize: 8, size: 'small' }}
                scroll={{ x: 900 }}
                columns={[
                  { title: '型号', dataIndex: 'model', width: 160 },
                  { title: '电站', dataIndex: 'plantName', width: 180, ellipsis: true },
                  { title: '方阵', dataIndex: 'arrayCode', width: 80 },
                  {
                    title: '额定',
                    dataIndex: 'ratedKw',
                    width: 90,
                    render: (value: number) => `${value} kW`,
                  },
                  { title: 'MPPT', dataIndex: 'mpptCount', width: 70 },
                  {
                    title: '投运',
                    dataIndex: 'commissionDate',
                    width: 150,
                    render: (value: string, row) => (
                      <span>
                        {value} <span className="gb-hint">{serviceYears(value)} 年</span>
                        {serviceYears(value) >= 4 ? <Tag color="orange">需评估</Tag> : null}
                        {stringsPerMppt(row, row.stringCount) > 4 ? <Tag color="red">接线拥挤</Tag> : null}
                      </span>
                    ),
                  },
                  {
                    title: '汇流箱',
                    dataIndex: 'boxCodes',
                    width: 150,
                    render: (codes: string[]) =>
                      codes.length === 0 ? (
                        <Tag>未配置</Tag>
                      ) : (
                        <Space size={4} wrap>
                          {codes.map((code) => (
                            <Tag key={code}>{code}</Tag>
                          ))}
                        </Space>
                      ),
                  },
                  {
                    title: '组串 / 失配',
                    width: 120,
                    render: (_, row) => (
                      <span>
                        {row.stringCount} /{' '}
                        <Typography.Text type={row.alarmStringCount > 0 ? 'danger' : 'success'}>
                          {row.alarmStringCount}
                        </Typography.Text>
                      </span>
                    ),
                  },
                  {
                    title: '状态',
                    width: 90,
                    render: (_, row) => {
                      const health = inverterHealth(row.alarmStringCount, row.stringCount);
                      const color = health === '正常' ? 'green' : health === '关注' ? 'orange' : 'red';
                      return <Tag color={color}>{health}</Tag>;
                    },
                  },
                  {
                    title: '操作',
                    width: 250,
                    fixed: 'right',
                    render: (_, row) => (
                      <Space size={2}>
                        <Button size="small" type="link" onClick={() => openStringDrawer(row.id, null)}>
                          组串
                        </Button>
                        <Button
                          size="small"
                          type="link"
                          icon={<SwapOutlined />}
                          disabled={Boolean(activeRelocation)}
                          onClick={() => openRelocationModal(row.id, row.boxCodes[0] ?? '')}
                        >
                          整箱改挂
                        </Button>
                        <Button
                          size="small"
                          type="link"
                          icon={<EditOutlined />}
                          onClick={() => openInverterModal(row)}
                        />
                        <Popconfirm
                          title="删除该逆变器及其全部组串与采集数据？"
                          okText="删除"
                          cancelText="取消"
                          onConfirm={async () => {
                            await deleteInverter(row.id);
                            message.success('逆变器已删除');
                          }}
                        >
                          <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        <Col xs={24} xl={9}>
          <Card
            size="small"
            title="三级结构树"
            extra={
              <Space size={4}>
                <Button size="small" onClick={expandAll}>
                  展开
                </Button>
                <Button size="small" onClick={collapseAll}>
                  收起
                </Button>
              </Space>
            }
            styles={{ body: { padding: 10, maxHeight: 560, overflow: 'auto' } }}
          >
            {plants.length === 0 ? (
              <EmptyPanel title="结构树为空" description="先建电站、方阵与逆变器。" />
            ) : (
              <Tree
                treeData={treeData}
                defaultExpandAll={false}
                expandedKeys={[
                  ...expandedInverterIds.map((id) => `inverter-${id}`),
                  ...plants.map((item) => `plant-${item.id}`),
                ]}
                onExpand={(keys) => {
                  const inverterKeys = keys
                    .map((key) => String(key))
                    .filter((key) => key.startsWith('inverter-'))
                    .map((key) => key.replace('inverter-', ''));
                  if (inverterKeys.length > expandedInverterIds.length) {
                    const added = inverterKeys.find((id) => !expandedInverterIds.includes(id));
                    if (added) toggleExpand(added);
                  } else {
                    const removed = expandedInverterIds.find((id) => !inverterKeys.includes(id));
                    if (removed) toggleExpand(removed);
                  }
                }}
                showLine
                selectable={false}
              />
            )}
          </Card>
        </Col>
      </Row>

      {/* 整箱改挂 */}
      <Modal
        title={frozenRelocationPlan ? '冻结核对完成 · 确认搬迁' : '旧逆变器退运 · 整箱组串改挂'}
        open={relocationModal.open}
        onCancel={() => void closeRelocationModal()}
        onOk={() => void (frozenRelocationPlan ? executeFrozenRelocation() : submitRelocation())}
        confirmLoading={relocationSubmitting}
        okText={frozenRelocationPlan ? '确认搬迁' : '冻结核对'}
        cancelText={frozenRelocationPlan ? '取消并解冻' : '取消'}
      >
        {frozenRelocationPlan ? (
          <Alert
            showIcon
            type="success"
            style={{ marginBottom: 12 }}
            message={`已冻结两端录入与派工，箱内 ${frozenRelocationPlan.stringCount} 串及采集/处置归属核对一致`}
            description={`未完成处置单 ${frozenRelocationPlan.unfinishedDisposalCount} 张将按新归属重派；已复测 ${frozenRelocationPlan.retestedDisposalCount} 张保留原基准。`}
          />
        ) : (
          <Alert
            showIcon
            type="info"
            style={{ marginBottom: 12 }}
            message="提交后先冻结两端录入与派工，核对箱内组串和采集/处置归属；确认范围后再搬迁。"
          />
        )}
        <Form form={relocationForm} layout="vertical" disabled={Boolean(frozenRelocationPlan)}>
          <Form.Item name="sourceCombinerBox" label="源汇流箱" rules={[{ required: true, message: '请选择源汇流箱' }]}>
            <Select
              options={[...new Set(strings.filter((item) => item.inverterId === relocationModal.sourceInverterId).map((item) => item.combinerBox))].map((box) => ({ label: box, value: box }))}
            />
          </Form.Item>
          <Form.Item name="targetInverterId" label="新逆变器" rules={[{ required: true, message: '请选择新逆变器' }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={inverters
                .filter((item) => item.id !== relocationModal.sourceInverterId)
                .map((item) => {
                  const array = arrays.find((arrayRow) => arrayRow.id === item.arrayId);
                  const plant = array ? plants.find((plantRow) => plantRow.id === array.plantId) : undefined;
                  return {
                    label: `${item.model} · ${plant?.name ?? '未归属电站'} / ${array?.code ?? '-'}`,
                    value: item.id,
                  };
                })}
            />
          </Form.Item>
          <Form.Item name="targetCombinerBox" label="目标汇流箱编号" rules={[{ required: true, message: '请输入目标汇流箱编号' }]}>
            <Input placeholder="默认沿用源汇流箱编号，目标箱必须为空" />
          </Form.Item>
          <Form.Item name="reason" label="改挂原因">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          未完成处置单将按新归属重派；已复测结论保留原基准。失败会恢复设备归属，重试不重复搬迁。
        </Typography.Paragraph>
      </Modal>

      {/* 逆变器表单 */}
      <Drawer
        title={inverterModal.editing ? '编辑逆变器' : '新增逆变器'}
        width={420}
        open={inverterModal.open}
        onClose={() => setInverterModal({ open: false, editing: null })}
        extra={
          <Space>
            <Button onClick={() => setInverterModal({ open: false, editing: null })}>取消</Button>
            <Button type="primary" onClick={() => void submitInverter()}>
              保存
            </Button>
          </Space>
        }
      >
        <Form form={inverterForm} layout="vertical">
          <Form.Item name="arrayId" label="所属方阵" rules={[{ required: true, message: '请选择方阵' }]}>
            <Select
              options={arrays.map((array) => {
                const plant = plants.find((item) => item.id === array.plantId);
                return { label: `${plant?.name ?? '-'} / ${array.code}`, value: array.id };
              })}
            />
          </Form.Item>
          <Form.Item name="model" label="型号" rules={[{ required: true, message: '请输入型号' }]}>
            <Input placeholder="如 SG3125HV-MV" />
          </Form.Item>
          <Form.Item name="ratedKw" label="额定功率（kW）" rules={[{ required: true, message: '请输入额定功率' }]}>
            <InputNumber min={1} max={10000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="mpptCount" label="MPPT 路数" rules={[{ required: true, message: '请输入 MPPT 路数' }]}>
            <InputNumber min={1} max={64} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="commissionDate" label="投运日期" rules={[{ required: true, message: '请选择投运日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Drawer>

      {/* 组串管理 */}
      <Drawer
        title={
          drawerInverter
            ? `组串挂接 · ${drawerInverter.model}（${drawerStrings.length} 串）`
            : '组串挂接'
        }
        width={880}
        open={stringDrawer.open}
        onClose={() => setStringDrawer({ open: false, inverterId: '', editing: null })}
      >
        <Row gutter={12}>
          <Col span={12}>
            <Card size="small" title={stringDrawer.editing ? '编辑组串' : '单个新增'}>
              <Form form={stringForm} layout="vertical" onFinish={() => void submitString()}>
                <Form.Item name="combinerBox" label="汇流箱编号" rules={[{ required: true, message: '请输入汇流箱编号' }]}>
                  <Input placeholder="BX-01" />
                </Form.Item>
                <Form.Item name="code" label="组串编号" rules={[{ required: true, message: '请输入组串编号' }]}>
                  <Input placeholder="01-01" />
                </Form.Item>
                <Form.Item name="moduleModel" label="组件型号" rules={[{ required: true, message: '请输入组件型号' }]}>
                  <Input placeholder="LR5-72HBD-545M" />
                </Form.Item>
                <Form.Item name="seriesCount" label="串联组件数" rules={[{ required: true, message: '请输入串联数' }]}>
                  <InputNumber min={1} max={60} style={{ width: '100%' }} />
                </Form.Item>
                <Space>
                  <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
                    {stringDrawer.editing ? '保存修改' : '新增组串'}
                  </Button>
                  {stringDrawer.editing ? (
                    <Button
                      onClick={() => {
                        setStringDrawer((prev) => ({ ...prev, editing: null }));
                        stringForm.resetFields();
                      }}
                    >
                      取消编辑
                    </Button>
                  ) : null}
                </Space>
              </Form>
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" title="批量新增（按起始序号连续生成）">
              <Form form={batchForm} layout="vertical" onFinish={() => void submitBatch()}>
                <Form.Item name="combinerBox" label="汇流箱编号" rules={[{ required: true, message: '请输入汇流箱编号' }]}>
                  <Input placeholder="BX-01" />
                </Form.Item>
                <Form.Item name="moduleModel" label="组件型号" rules={[{ required: true, message: '请输入组件型号' }]}>
                  <Input placeholder="JKM560M-72HL4" />
                </Form.Item>
                <Form.Item name="seriesCount" label="串联组件数" rules={[{ required: true, message: '请输入串联数' }]}>
                  <InputNumber min={1} max={60} style={{ width: '100%' }} defaultValue={26} />
                </Form.Item>
                <Row gutter={8}>
                  <Col span={12}>
                    <Form.Item name="startSeq" label="起始序号" rules={[{ required: true, message: '请输入起始序号' }]}>
                      <InputNumber min={1} max={200} style={{ width: '100%' }} defaultValue={1} />
                    </Form.Item>
                  </Col>
                  <Col span={12}>
                    <Form.Item name="count" label="生成条数" rules={[{ required: true, message: '请输入条数' }]}>
                      <InputNumber min={1} max={32} style={{ width: '100%' }} defaultValue={4} />
                    </Form.Item>
                  </Col>
                </Row>
                <Button type="primary" htmlType="submit" icon={<ThunderboltOutlined />}>
                  批量生成组串
                </Button>
              </Form>
            </Card>
          </Col>
        </Row>

        <Table<StringRow>
          style={{ marginTop: 12 }}
          rowKey="id"
          size="small"
          dataSource={drawerStrings}
          pagination={{ pageSize: 8, size: 'small' }}
          locale={{
            emptyText: <EmptyPanel title="该逆变器下暂无组串" description="用左侧表单新增或批量生成组串。" />,
          }}
          columns={[
            { title: '汇流箱', dataIndex: 'combinerBox', width: 100 },
            { title: '组串编号', dataIndex: 'code', width: 110 },
            { title: '组件型号', dataIndex: 'moduleModel', width: 170 },
            { title: '串联数', dataIndex: 'seriesCount', width: 90 },
            {
              title: '理论开路电压',
              width: 130,
              render: (_, row) => formatVoltage(expectedVoc(row.seriesCount)),
            },
            {
              title: '离散率',
              width: 140,
              render: (_, row) => (
                <DiscreteBadge
                  rate={stringAlarmRates[row.id] ?? 0}
                  thresholds={thresholds}
                  size="small"
                />
              ),
            },
            {
              title: '操作',
              width: 130,
              render: (_, row) => (
                <Space size={2}>
                  <Button size="small" type="link" onClick={() => openStringDrawer(row.inverterId, row)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除该组串及其采集与处置单？"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={async () => {
                      await deleteString(row.id);
                      message.success('组串已删除');
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

        <Typography.Paragraph type="secondary" style={{ marginTop: 10 }}>
          当前逆变器挂接组串平均电流参考：
          {stats
            .filter((stat) => stat.inverterId === stringDrawer.inverterId)
            .slice(0, 4)
            .map((stat) => `${stat.stringCode} ${formatCurrent(stat.avgCurrentA)}`)
            .join(' · ') || '暂无采集数据'}
        </Typography.Paragraph>
      </Drawer>
    </div>
  );
}
