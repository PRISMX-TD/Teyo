export type ScenarioId =
  | 'money-in' | 'money-out' | 'buy-stock' | 'move-money' | 'not-sure';

export type Scenario = {
  id: ScenarioId;
  kind: 'income' | 'expense' | 'transfer' | 'journal';
  /** 预选的分类科目编码；null 表示由用户选择。 */
  defaultAccountCode: string | null;
  /** 该场景是否需要用户选择分类。 */
  needsCategory: boolean;
  /** 该场景是否需要用户选择交易方向（收入或支出）。 */
  needsDirection: boolean;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'money-in',
    kind: 'income',
    defaultAccountCode: null,
    needsCategory: true,
    needsDirection: false,
  },
  {
    id: 'money-out',
    kind: 'expense',
    defaultAccountCode: null,
    needsCategory: true,
    needsDirection: false,
  },
  {
    id: 'buy-stock',
    kind: 'expense',
    defaultAccountCode: 'purchases',
    needsCategory: false,
    needsDirection: false,
  },
  {
    id: 'move-money',
    kind: 'transfer',
    defaultAccountCode: null,
    needsCategory: false,
    needsDirection: false,
  },
  {
    // User uncertainty is about category, never about direction: if they select this,
    // they explicitly know whether money came in or went out. Presetting direction
    // (e.g., kind='expense') would silently record an incoming deposit as a bank-balance
    // decrease, reintroducing the data-corruption failure suspense exists to prevent.
    id: 'not-sure',
    kind: 'journal',
    defaultAccountCode: 'suspense',
    needsCategory: false,
    needsDirection: true,
  },
];

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find(s => s.id === id);
}
