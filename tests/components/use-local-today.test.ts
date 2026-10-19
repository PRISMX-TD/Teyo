import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { localDateFromISO, useLocalToday } from '@/components/ui/use-local-today';
import { addMonthsLocalISO, todayLocalISO } from '@/lib/date';

function Probe() {
  const today = useLocalToday();
  return createElement('input', { type: 'date', value: today, readOnly: true });
}

describe('useLocalToday', () => {
  // 服务端渲染（以及水合）必须输出与时区无关的空值，否则服务器的 UTC 日期
  // 会被冻结在受控日期框里，见 components/ui/use-local-today.ts。
  it('renders an empty date on the server', () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain('value=""');
  });
});

describe('localDateFromISO', () => {
  it('round-trips through todayLocalISO without a UTC shift', () => {
    expect(todayLocalISO(localDateFromISO('2024-03-01'))).toBe('2024-03-01');
  });

  it('feeds addMonthsLocalISO with month-end clamping', () => {
    expect(addMonthsLocalISO(1, localDateFromISO('2024-01-31'))).toBe('2024-02-29');
  });
});
