/**
 * 全应用唯一的图标出口（Phosphor）。
 *
 * 只从这里取图标，不在组件里直接 import '@phosphor-icons/react'：
 *   - 走 dist/ssr/<Name> 的单文件路径。包的根入口是一个 1500 个图标的
 *     barrel，开发时每次编译都要把它整个过一遍；单文件路径只编译用到的。
 *   - ssr 版不读 React context，Server Component 与 Client Component
 *     都能直接用，不用给每个页面套 'use client'。
 *   - 一个家族、一种粗细约定：导航与行图标用 regular（当前项换 fill），
 *     控件里的小图标（返回、加号、眼睛）用 bold，与 14-15px 的字重相配。
 */
export { AddressBook } from '@phosphor-icons/react/dist/ssr/AddressBook';
export { ArrowsClockwise } from '@phosphor-icons/react/dist/ssr/ArrowsClockwise';
export { ArrowsDownUp } from '@phosphor-icons/react/dist/ssr/ArrowsDownUp';
export { Bank } from '@phosphor-icons/react/dist/ssr/Bank';
export { BookOpenText } from '@phosphor-icons/react/dist/ssr/BookOpenText';
export { Briefcase } from '@phosphor-icons/react/dist/ssr/Briefcase';
export { Buildings } from '@phosphor-icons/react/dist/ssr/Buildings';
export { CalendarCheck } from '@phosphor-icons/react/dist/ssr/CalendarCheck';
export { CaretLeft } from '@phosphor-icons/react/dist/ssr/CaretLeft';
export { ChartBar } from '@phosphor-icons/react/dist/ssr/ChartBar';
export { ChartPieSlice } from '@phosphor-icons/react/dist/ssr/ChartPieSlice';
export { CheckCircle } from '@phosphor-icons/react/dist/ssr/CheckCircle';
export { Circle } from '@phosphor-icons/react/dist/ssr/Circle';
export { ClockCounterClockwise } from '@phosphor-icons/react/dist/ssr/ClockCounterClockwise';
export { DotsThreeCircle } from '@phosphor-icons/react/dist/ssr/DotsThreeCircle';
export { Export } from '@phosphor-icons/react/dist/ssr/Export';
export { Eye } from '@phosphor-icons/react/dist/ssr/Eye';
export { EyeSlash } from '@phosphor-icons/react/dist/ssr/EyeSlash';
export { GearSix } from '@phosphor-icons/react/dist/ssr/GearSix';
export { HandCoins } from '@phosphor-icons/react/dist/ssr/HandCoins';
export { House } from '@phosphor-icons/react/dist/ssr/House';
export { Invoice } from '@phosphor-icons/react/dist/ssr/Invoice';
export { Moon } from '@phosphor-icons/react/dist/ssr/Moon';
export { Package } from '@phosphor-icons/react/dist/ssr/Package';
export { Percent } from '@phosphor-icons/react/dist/ssr/Percent';
export { Plus } from '@phosphor-icons/react/dist/ssr/Plus';
export { PlusCircle } from '@phosphor-icons/react/dist/ssr/PlusCircle';
export { Receipt } from '@phosphor-icons/react/dist/ssr/Receipt';
export { ReceiptX } from '@phosphor-icons/react/dist/ssr/ReceiptX';
export { Scales } from '@phosphor-icons/react/dist/ssr/Scales';
export { SealQuestion } from '@phosphor-icons/react/dist/ssr/SealQuestion';
export { ShoppingCartSimple } from '@phosphor-icons/react/dist/ssr/ShoppingCartSimple';
export { SignOut } from '@phosphor-icons/react/dist/ssr/SignOut';
export { Storefront } from '@phosphor-icons/react/dist/ssr/Storefront';
export { Swap } from '@phosphor-icons/react/dist/ssr/Swap';
export { Tag } from '@phosphor-icons/react/dist/ssr/Tag';
export { UserCircle } from '@phosphor-icons/react/dist/ssr/UserCircle';
export { UsersThree } from '@phosphor-icons/react/dist/ssr/UsersThree';
export { Wallet } from '@phosphor-icons/react/dist/ssr/Wallet';
export { X } from '@phosphor-icons/react/dist/ssr/X';
export type { Icon, IconProps } from '@phosphor-icons/react/dist/lib/types';
