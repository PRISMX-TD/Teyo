/**
 * 浏览器本地日期，格式 YYYY-MM-DD。
 *
 * 表单上那些「默认今天」的日期框此前一律写 `new Date().toISOString().slice(0, 10)`。
 * `toISOString()` **先把时间转成 UTC** 再格式化，所以对一个 UTC+8 的用户，
 * 每天 00:00–08:00 这八个小时里，表单默认填的是**昨天**。
 *
 * 一个在晚上十点收摊、第二天清早六点补录昨天流水的店主，看到的默认日期
 * 会是前天——他多半不会去看那一栏，于是一整笔账记错了日期。这不是排版
 * 问题：日期决定它落在哪个月的损益表、以及会不会撞上已封账的期间。
 *
 * 这里取的是本地日期分量（getFullYear/getMonth/getDate），也就是用户设备上
 * 显示的那个日期——那正是他心里的「今天」。
 *
 * 与服务端的 todayInOrg（server/auth/guard.ts）分工：那个按**公司**时区算，
 * 用于报表口径与定期规则；这个按**用户设备**时区算，用于表单默认值。两者
 * 通常相同，出差时不同，而那时用户想填的确实是他人在的地方的今天。
 */
export function todayLocalISO(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 本地日期加上若干天，格式 YYYY-MM-DD。
 *
 * 给「默认到期日 = 今天 + 30 天」这类用途。用 setDate 而不是加毫秒：
 * 跨夏令时的那一天不是 24 小时，加毫秒会算出前一天或后一天。
 */
export function addDaysLocalISO(days: number, from: Date = new Date()): string {
  const date = new Date(from);
  date.setDate(date.getDate() + days);
  return todayLocalISO(date);
}

/**
 * 本地日期加上若干个月，格式 YYYY-MM-DD，**月末夹取**。
 *
 * 发票与账单的默认到期日是「下个月的今天」，原来写的是
 * `d.setMonth(d.getMonth() + 1)`。JS 的 setMonth 在目标月份没有这一天时会
 * **往后溢出**：1 月 31 日加一个月得到的是 3 月 3 日（2 月只有 28 天，多出
 * 的 3 天顺延）。一张 1 月 31 日开的月结发票，到期日会落在 3 月 3 日而不是
 * 2 月 28 日——账龄表因此少算一个桶，催收也晚三天。
 *
 * 夹取到目标月的最后一天才是「月结」这个词的意思。
 */
export function addMonthsLocalISO(months: number, from: Date = new Date()): string {
  const year = from.getFullYear();
  const month = from.getMonth() + months;
  const day = from.getDate();

  // 目标月的最后一天：下个月的第 0 天。这里全程用本地时间分量构造，
  // 不经 UTC。
  const lastDayOfTargetMonth = new Date(year, month + 1, 0).getDate();
  return todayLocalISO(new Date(year, month, Math.min(day, lastDayOfTargetMonth)));
}

/** 本地日期所在年份的 1 月 1 日。报表默认区间用。 */
export function startOfLocalYear(date: Date = new Date()): string {
  return `${date.getFullYear()}-01-01`;
}
