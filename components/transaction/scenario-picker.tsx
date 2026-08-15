import Link from 'next/link';
import type { Locale } from '@/lib/i18n';
import { getMessages } from '@/lib/i18n';
import { SCENARIOS, type ScenarioId } from '@/server/domain/scenario';

type Props = {
  orgSlug: string;
  locale: Locale;
};

// server/domain/scenario.ts 只携带稳定的 id，文案键名在这里一一对应，
// 少一条或拼错都会在编译期报错（t.scenario 是按 en.ts 结构收窄的类型）。
const TITLE_KEY: Record<ScenarioId, 'moneyIn' | 'moneyOut' | 'buyStock' | 'moveMoney' | 'notSure'> = {
  'money-in': 'moneyIn',
  'money-out': 'moneyOut',
  'buy-stock': 'buyStock',
  'move-money': 'moveMoney',
  'not-sure': 'notSure',
};

const HINT_KEY: Record<
  ScenarioId,
  'moneyInHint' | 'moneyOutHint' | 'buyStockHint' | 'moveMoneyHint' | 'notSureHint'
> = {
  'money-in': 'moneyInHint',
  'money-out': 'moneyOutHint',
  'buy-stock': 'buyStockHint',
  'move-money': 'moveMoneyHint',
  'not-sure': 'notSureHint',
};

/**
 * 场景卡片入口：/[orgSlug]/transactions/new 默认渲染这里，而不是老的
 * 类型/账户/分类三连表单。每张卡指向 ?scenario=<id>，由页面解析出
 * Scenario 并把预配置传给 TransactionForm。
 *
 * not-sure 卡视觉上弱化（scenario-secondary：透明底、虚线框），但不隐藏——
 * 用户不确定归类时，这张卡和悬置科目一起，是唯一能让账继续配平的出口。
 */
export function ScenarioPicker({ orgSlug, locale }: Props) {
  const t = getMessages(locale);

  return (
    <>
      <h1>{t.scenario.title}</h1>
      <div className="scenario-grid">
        {SCENARIOS.map((scenario) => (
          <Link
            key={scenario.id}
            href={`/${orgSlug}/transactions/new?scenario=${scenario.id}`}
            className={
              scenario.id === 'not-sure' ? 'scenario-card scenario-secondary' : 'scenario-card'
            }
          >
            <strong>{t.scenario[TITLE_KEY[scenario.id]]}</strong>
            <span>{t.scenario[HINT_KEY[scenario.id]]}</span>
          </Link>
        ))}
      </div>
      <p>
        <Link href={`/${orgSlug}/transactions/new?scenario=advanced`}>{t.scenario.useAdvanced}</Link>
      </p>
    </>
  );
}
