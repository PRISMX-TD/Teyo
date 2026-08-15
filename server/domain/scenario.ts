export type ScenarioId =
  | 'money-in' | 'money-out' | 'buy-stock' | 'move-money' | 'not-sure';

export type Scenario = {
  id: ScenarioId;
  kind: 'income' | 'expense' | 'transfer' | 'journal';
  /** 预选的分类科目编码；null 表示由用户选择。 */
  defaultAccountCode: string | null;
  /** 该场景是否需要用户选择分类。 */
  needsCategory: boolean;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'money-in',
    kind: 'income',
    defaultAccountCode: null,
    needsCategory: true,
  },
  {
    id: 'money-out',
    kind: 'expense',
    defaultAccountCode: null,
    needsCategory: true,
  },
  {
    id: 'buy-stock',
    kind: 'expense',
    defaultAccountCode: 'purchases',
    needsCategory: false,
  },
  {
    id: 'move-money',
    kind: 'transfer',
    defaultAccountCode: null,
    needsCategory: false,
  },
  {
    id: 'not-sure',
    kind: 'journal',
    defaultAccountCode: 'suspense',
    needsCategory: false,
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find(s => s.id === id);
}
