/**
 * <FreezeBanner> 冻结期横幅
 * 整箱改挂冻结两端（设备台账录入 + 采集处置录入/派工）时，在相关页面顶部统一提示。
 * 复测回填不改变归属、保留原基准，故不在禁止之列。
 */
import { Alert, Button, Space, Tag, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useMigrationStore } from '../../stores/migrationStore';
import { ROUTES } from '../../router/routes';

export interface FreezeBannerProps {
  /** 本页被冻结的具体动作描述，如「逆变器/组串录入与删除」 */
  scope?: string;
  /** 是否展示「前往改挂工作台」按钮（工作台自身传 false） */
  showEntry?: boolean;
}

export default function FreezeBanner({ scope, showEntry = true }: FreezeBannerProps) {
  const navigate = useNavigate();
  const isFrozen = useMigrationStore((state) => state.freeze?.frozen === true);
  const info = useMigrationStore((state) => state.freeze);
  if (!isFrozen || !info) return null;
  return (
    <Alert
      style={{ marginBottom: 12 }}
      type="warning"
      showIcon
      icon={<LockOutlined />}
      message={
        <Space size={8} wrap>
          <Typography.Text strong>改挂冻结期：两端录入与派工已暂停</Typography.Text>
          {scope ? <Tag color="orange">{scope}</Tag> : null}
          <Tag>操作人：{info.operator || '—'}</Tag>
          {info.frozenAt ? <Tag>冻结于 {info.frozenAt.slice(0, 16).replace('T', ' ')}</Tag> : null}
        </Space>
      }
      description={
        <Space direction="vertical" size={4}>
          <span>{info.reason || '旧逆变器退运、整箱组串改挂中，完成对账与搬迁后自动解冻。'}</span>
          <span className="gb-hint">复测回填仍可进行（保留原基准结论）；其余录入、编辑、删除与派工按钮已禁用。</span>
          {showEntry ? (
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => navigate(ROUTES.migration)}>
              前往整箱改挂工作台 →
            </Button>
          ) : null}
        </Space>
      }
    />
  );
}
