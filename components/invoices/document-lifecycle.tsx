import type { ReactNode } from 'react';

type Step = {
  /** 数据库里的状态值。 */
  value: string;
  label: string;
};

type Props = {
  /** 给这条状态条的无障碍名称，例如「这张发票走到哪一步」。 */
  caption: string;
  steps: Step[];
  current: string;
  /** 已作废：整条线不再适用，单独说明，不假装它还停在某一步上。 */
  voided?: boolean;
  voidedLabel?: string;
  /** 当前这一步下面那句解释（草稿不进账、已过账改动会重建分录……）。 */
  notice?: ReactNode;
};

/**
 * 单据状态机的可视化：draft → sent → paid 这条线走到哪儿了。
 *
 * 为什么要有这个东西：这一轮之前，发票建出来永远停在 draft，界面上也就
 * 没有「状态」这个概念可言——一个徽章足够了。现在 draft 与 sent 之间隔着
 * 一次真实的过账（收入确认、应收挂账），用户必须看得出自己在哪一侧，以及
 * 往前走一步会发生什么。一个孤零零的徽章说不出「还有下一步」。
 *
 * 用 `<ol>` 而不是一排 `<span>`：这是有序的几步，序号本身是信息。
 * 当前这一步带 `aria-current="step"`——这正是 aria-current 的 `step` 取值
 * 存在的理由（W3C ARIA 1.2 定义它为「一组步骤中的当前步」）。读屏器会把它
 * 念成「当前步骤」，视觉用户看到的是高亮，两边拿到的是同一件事。
 *
 * 已作废不是这条线上的一步，而是这条线作废了。所以 voided 时不去给任何
 * 一步加 aria-current——那会让读屏器宣布用户「正处在」一个他已经退出的
 * 流程里——而是把整条线标成 aria-disabled 并单列一个作废徽章。
 */
export function DocumentLifecycle({
  caption,
  steps,
  current,
  voided = false,
  voidedLabel,
  notice,
}: Props) {
  return (
    <div className="doc-lifecycle">
      <p className="doc-lifecycle__caption" id="doc-lifecycle-caption">
        {caption}
      </p>
      {/* 作废时用 data-voided 而不是 aria-disabled：aria-disabled 在
          role="list"（<ol> 的隐含角色）上不是受支持的属性，读屏器不会念它，
          写上去只是给自己一个「已经告诉用户了」的错觉。真正把这件事说出来的
          是下面那个作废徽章，以及「没有任何一步带 aria-current」这个事实。
          这里只留一个纯样式钩子，让整条线看起来是灰的。 */}
      <ol
        className="doc-lifecycle__steps"
        aria-labelledby="doc-lifecycle-caption"
        data-voided={voided || undefined}
      >
        {steps.map((step) => {
          const isCurrent = !voided && step.value === current;
          return (
            <li
              key={step.value}
              className="doc-lifecycle__step"
              aria-current={isCurrent ? 'step' : undefined}
            >
              {step.label}
            </li>
          );
        })}
      </ol>

      {voided && voidedLabel ? (
        <p className="doc-lifecycle__voided">
          <span className="badge badge-voided">{voidedLabel}</span>
        </p>
      ) : null}

      {/* role="status" 而不是 role="alert"：这是在陈述记录现在的处境，
          不是一个需要打断用户的错误。 */}
      {notice ? (
        <p className="doc-lifecycle__notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
