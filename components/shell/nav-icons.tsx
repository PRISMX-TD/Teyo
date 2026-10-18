import {
  AddressBook,
  ArrowsClockwise,
  ArrowsDownUp,
  Bank,
  BookOpenText,
  Briefcase,
  Buildings,
  CalendarCheck,
  ChartBar,
  ChartPieSlice,
  ClockCounterClockwise,
  DotsThreeCircle,
  Export,
  GearSix,
  HandCoins,
  House,
  Invoice,
  Moon,
  Package,
  Percent,
  PlusCircle,
  Receipt,
  ReceiptX,
  Scales,
  SealQuestion,
  ShoppingCartSimple,
  Storefront,
  Swap,
  Tag,
  UserCircle,
  UsersThree,
  Wallet,
  type Icon,
} from '@/components/ui/icons';

/**
 * 每个目的地一个图标，侧栏、手机底栏、「更多」页、设置页共用这一张表——
 * 同一个地方在四处入口长同一个样子，用户认图标就能认路。
 */
export const NAV_ICONS = {
  overview: House,
  transactions: ArrowsDownUp,
  uncertain: SealQuestion,
  invoices: Invoice,
  payments: HandCoins,
  creditNotes: ReceiptX,
  purchaseOrders: ShoppingCartSimple,
  bills: Receipt,
  reports: ChartBar,
  generalLedger: BookOpenText,
  reconciliation: Scales,
  budgets: ChartPieSlice,
  projects: Briefcase,
  bankImport: Bank,
  fixedAssets: Buildings,
  export: Export,
  settings: GearSix,
  tax: Percent,
  more: DotsThreeCircle,
  account: UserCircle,
  switchCompany: Swap,
  newCompany: PlusCircle,
  theme: Moon,
  // 设置的子页
  general: Storefront,
  members: UsersThree,
  categories: Tag,
  accounts: Wallet,
  recurring: ArrowsClockwise,
  contacts: AddressBook,
  inventory: Package,
  yearEnd: CalendarCheck,
  audit: ClockCounterClockwise,
} satisfies Record<string, Icon>;

export type NavIconName = keyof typeof NAV_ICONS;

/**
 * 当前项换成实心（fill），其余用线框（regular）——iOS 标签栏的做法。
 * 颜色之外再多一个形状上的信号，色弱用户也分得出哪一项是当前页。
 */
export function NavIcon({
  name,
  active = false,
  size = 20,
}: {
  name: NavIconName;
  active?: boolean;
  size?: number;
}) {
  const Glyph = NAV_ICONS[name];
  return <Glyph className="nav-icon" size={size} weight={active ? 'fill' : 'regular'} aria-hidden="true" />;
}
