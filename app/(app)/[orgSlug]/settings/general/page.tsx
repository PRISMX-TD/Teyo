import { BackLink } from '@/components/ui/back-link';
import { redirect } from 'next/navigation';
import { getMessages, interpolate } from '@/lib/i18n';
import { INVOICE_LOCALES, INVOICE_LOCALE_NAMES } from '@/lib/invoice-options';
import { requirePermission } from '@/server/auth/guard';
import { withTransaction } from '@/server/db/transaction';
import { can } from '@/server/domain/permissions';
import { updatePeriodLock, updateOrganization } from '@/server/actions/organizations';
import { getOrganizationSettings, getUserLocale } from '@/server/repositories/organizations';
import { getLogoSignedUrl, getPaymentImageUrls } from '@/server/services/organization-logo';
import { LogoUploader } from '@/components/settings/logo-uploader';
import { PaymentDetailsField } from '@/components/settings/payment-details-field';

/**
 * 财年起始月的选项。1–12 按顺序列出，标签由 i18n 的 settings.month1..month12
 * 给出——不用 Intl.DateTimeFormat 动态生成月份名：那会在服务端按运行时
 * locale 渲染一次、在客户端 hydrate 时按浏览器 locale 再渲染一次，两者不同
 * 就是一次 hydration mismatch，而这个页面上没有任何东西会提示它发生了。
 */
const MONTH_KEYS = [
  'month1', 'month2', 'month3', 'month4', 'month5', 'month6',
  'month7', 'month8', 'month9', 'month10', 'month11', 'month12',
] as const;

/**
 * 保存成功的回执。
 *
 * 这一页的两个保存按钮此前既不跳转也不提示：点下去，表单原地不动，用户
 * 没有任何办法判断改动到底有没有写进去——尤其是公司名这种改完之后长得
 * 和改之前一模一样的字段。这里是 Server Action + 原生 <form>，没有客户端
 * state 可用，所以回执走「保存完 redirect 回本页并带一个查询参数」这条路：
 * 它同时清掉了浏览器里那次 POST，用户刷新页面不会被问「要不要重新提交」。
 *
 * 用两个值而不是一个 ?saved=1，是为了让提示出现在他刚操作的那一节旁边；
 * 页面顶上一句笼统的「已保存」说不清楚保存的是锁账期还是公司资料。
 */
type SavedSection = 'lock' | 'general';

export default async function GeneralSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { orgSlug } = await params;
  const saved = (await searchParams).saved as SavedSection | undefined;
  const context = await requirePermission(orgSlug, 'account:manage');
  const locale = (await getUserLocale(context.userId)) as 'en' | 'zh';
  const t = getMessages(locale);

  // 表单此前不回填任何一个字段：name 是空的、时区永远显示吉隆坡、行业是空的。
  // 于是「只想改个行业」的用户一保存，时区就被静默改回吉隆坡——而时区决定
  // todayInOrg，也就是每一张报表的「今天」。回填不是润色，是修一个数据损坏。
  const settings = await withTransaction(context.userId, (tx) =>
    getOrganizationSettings(tx, context.organizationId),
  );
  const logoUrl = await getLogoSignedUrl(settings.logoPath);
  const paymentImages = await getPaymentImageUrls(settings.paymentImagePaths);

  return (
    <>
      <BackLink href={`/${orgSlug}/settings`}>{t.nav.settings}</BackLink>
      <h1>{t.settings.general}</h1>

      {/*
        公司资料在最前面，封账挪到最底下：原来首屏是一年用不了一次、而且
        不可逆的「锁定账本」，真正常改的资料要往下翻。表单按组分成卡片，
        原来所有字段直接落在灰底上，一屏屏地往下排；第一组原来顶着一个和
        h1 一模一样的「公司资料」小标题。
      */}
      <form
        className="settings-form"
        action={async (formData: FormData) => {
          'use server';
          await updateOrganization(orgSlug, {
            name: String(formData.get('name') ?? ''),
            timezone: String(formData.get('timezone') ?? ''),
            industry: String(formData.get('industry') ?? '') || undefined,
            address: String(formData.get('address') ?? '') || undefined,
            registrationNumber: String(formData.get('registrationNumber') ?? '') || undefined,
            taxNumber: String(formData.get('taxNumber') ?? '') || undefined,
            phone: String(formData.get('phone') ?? '') || undefined,
            email: String(formData.get('email') ?? '') || undefined,
            paymentDetails: String(formData.get('paymentDetails') ?? '') || undefined,
            invoiceLocale: String(formData.get('invoiceLocale') ?? '') || undefined,
            invoiceSignoff: String(formData.get('invoiceSignoff') ?? '') || undefined,
            invoiceTaxLabel: String(formData.get('invoiceTaxLabel') ?? '') || undefined,
            invoiceFooter: String(formData.get('invoiceFooter') ?? '') || undefined,
            fiscalYearStartMonth: String(formData.get('fiscalYearStartMonth') ?? ''),
          });
          redirect(`/${orgSlug}/settings/general?saved=general`);
        }}
      >
        <fieldset className="settings-fieldset">
          <legend>{t.settings.basicsTitle}</legend>

          <label htmlFor="name">{t.settings.name}</label>
          <input id="name" name="name" required maxLength={120} defaultValue={settings.name} />

          <label htmlFor="timezone">{t.onboarding.timezone}</label>
          <select id="timezone" name="timezone" defaultValue={settings.timezone}>
            <option value="Asia/Kuala_Lumpur">Kuala Lumpur (GMT+8)</option>
            <option value="Asia/Singapore">Singapore (GMT+8)</option>
            <option value="Asia/Shanghai">Shanghai (GMT+8)</option>
            {/* 库里的时区不在上面三个里时（比如回退值 UTC），不补这一项的话
                下拉会显示第一项，一保存就把时区静默改成吉隆坡。 */}
            {['Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Shanghai'].includes(settings.timezone) ? null : (
              <option value={settings.timezone}>{settings.timezone}</option>
            )}
          </select>

          <label htmlFor="industry">{t.onboarding.industry}</label>
          <input id="industry" name="industry" maxLength={60} defaultValue={settings.industry ?? ''} />

          <label htmlFor="fiscalYearStartMonth">{t.settings.fiscalYearStart}</label>
          <select
            id="fiscalYearStartMonth"
            name="fiscalYearStartMonth"
            defaultValue={String(settings.fiscalYearStartMonth)}
          >
            {MONTH_KEYS.map((key, index) => (
              <option key={key} value={index + 1}>
                {t.settings[key]}
              </option>
            ))}
          </select>
          <p className="field-hint">{t.settings.fiscalYearStartHint}</p>
        </fieldset>

        {/*
          发票上的卖方资料。和公司名、时区放在同一张表单里一起保存：分成两张
          表单的话，用户改完这一组、点了另一组的保存按钮，这一组就白填了。
        */}
        <fieldset className="settings-fieldset">
          <legend>{t.settings.invoiceProfileTitle}</legend>
          <p className="field-hint">{t.settings.invoiceProfileHint}</p>

          {/*
            开票方地址。发票单据（invoices/[id]/print）会把它印在公司名下面——
            一张寄给客户的发票上没有开票方地址，很多地方在法律上就不算一张发票。
            这一列是 0026 迁移补的：在此之前 getInvoicePdfData 一直在
            `select name, address from organizations`，而那一列根本不存在，
            于是「下载发票」每一次都撞 42703，从上线起一次都没成功过。

            用 textarea：地址通常要分两三行写，单行框里打不出换行，印出来就是
            挤成一长串的一行。打印页按原样保留换行。
          */}
          <label htmlFor="address">{t.settings.companyAddress}</label>
          <textarea
            id="address"
            name="address"
            rows={3}
            maxLength={300}
            defaultValue={settings.address ?? ''}
          />

          <label htmlFor="registrationNumber">{t.settings.registrationNumber}</label>
          <input
            id="registrationNumber"
            name="registrationNumber"
            maxLength={60}
            defaultValue={settings.registrationNumber ?? ''}
          />

          <label htmlFor="taxNumber">{t.settings.taxNumber}</label>
          <input
            id="taxNumber"
            name="taxNumber"
            maxLength={60}
            defaultValue={settings.taxNumber ?? ''}
          />

          <label htmlFor="phone">{t.settings.phone}</label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            maxLength={40}
            defaultValue={settings.phone ?? ''}
          />

          <label htmlFor="email">{t.settings.companyEmail}</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            maxLength={254}
            defaultValue={settings.email ?? ''}
          />

          {/* 文字跟着这张表单保存；贴进来的图片当场上传，见组件里的注释。 */}
          <label htmlFor="paymentDetails">{t.settings.paymentDetails}</label>
          <PaymentDetailsField
            orgSlug={orgSlug}
            defaultValue={settings.paymentDetails ?? ''}
            images={paymentImages}
            t={t}
          />
        </fieldset>

        {/*
          发票怎么印。每一项都有一个宽松的默认值、都可以不管：不是每家公司
          都照同一套规矩开发票，这里只给选择，不替谁做决定。
        */}
        <fieldset className="settings-fieldset">
          <legend>{t.settings.invoiceLayoutTitle}</legend>
          <p className="field-hint">{t.settings.invoiceLayoutHint}</p>

          <label htmlFor="invoiceLocale">{t.settings.invoiceLanguage}</label>
          <select
            id="invoiceLocale"
            name="invoiceLocale"
            aria-describedby="invoiceLocaleHint"
            defaultValue={settings.invoiceLocale}
          >
            {INVOICE_LOCALES.map((option) => (
              <option key={option} value={option}>
                {INVOICE_LOCALE_NAMES[option]}
              </option>
            ))}
          </select>
          <p id="invoiceLocaleHint" className="field-hint">
            {t.settings.invoiceLanguageHint}
          </p>

          <label htmlFor="invoiceTaxLabel">{t.settings.invoiceTaxLabel}</label>
          <input
            id="invoiceTaxLabel"
            name="invoiceTaxLabel"
            maxLength={40}
            aria-describedby="invoiceTaxLabelHint"
            defaultValue={settings.invoiceTaxLabel ?? ''}
          />
          <p id="invoiceTaxLabelHint" className="field-hint">
            {t.settings.invoiceTaxLabelHint}
          </p>

          <label htmlFor="invoiceSignoff">{t.settings.invoiceSignoff}</label>
          {/* 选项用短说法：原来那一整句在 320 宽的手机上被下拉框截在半个词上。 */}
          <select id="invoiceSignoff" name="invoiceSignoff" defaultValue={settings.invoiceSignoff}>
            <option value="computer_generated">{t.settings.invoiceSignoffComputerShort}</option>
            <option value="signature">{t.settings.invoiceSignoffSignature}</option>
            <option value="none">{t.settings.invoiceSignoffNone}</option>
          </select>

          <label htmlFor="invoiceFooter">{t.settings.invoiceFooter}</label>
          <textarea
            id="invoiceFooter"
            name="invoiceFooter"
            rows={3}
            maxLength={1000}
            aria-describedby="invoiceFooterHint"
            defaultValue={settings.invoiceFooter ?? ''}
          />
          <p id="invoiceFooterHint" className="field-hint">
            {t.settings.invoiceFooterHint}
          </p>
        </fieldset>

        {saved === 'general' ? (
          <p role="status" className="form-success">
            {t.settings.saved}
          </p>
        ) : null}

        <button type="submit">{t.settings.save}</button>
      </form>

      <section className="settings-section">
        <h2>{t.settings.logoTitle}</h2>
        <div className="settings-card">
          <LogoUploader
            orgSlug={orgSlug}
            orgName={settings.name}
            hasLogo={settings.logoPath !== null}
            logoUrl={logoUrl}
            t={t}
          />
        </div>
      </section>

      {/* 封账：少用、不可逆，放在最后。lockHint 与 lockWarning 说的是同一件事，
          只留更完整的那一句。年结页的「去封账」直接跳到这里（#lock）。 */}
      {can(context.role, 'period:lock') && (
        <section id="lock" className="settings-section settings-lock">
          <h2>{t.settings.lockTitle}</h2>
          <div className="settings-card">
            <p className="settings-lock-status">
              {context.lockedUntil
                ? interpolate(t.settings.lockCurrent, { date: context.lockedUntil })
                : t.settings.lockNone}
            </p>
            <p className="field-hint">{t.settings.lockWarning}</p>
            <form
              action={async (formData: FormData) => {
                'use server';
                const lockDate = String(formData.get('lockDate') ?? '');
                if (!lockDate) return;
                await updatePeriodLock(orgSlug, { lockedUntil: lockDate || null });
                redirect(`/${orgSlug}/settings/general?saved=lock#lock`);
              }}
            >
              <label htmlFor="lockDate">{t.settings.lockDate}</label>
              <input id="lockDate" name="lockDate" type="date" required />
              <button type="submit">{t.settings.lockSubmit}</button>
            </form>
            {saved === 'lock' ? (
              <p role="status" className="form-success">
                {t.settings.saved}
              </p>
            ) : null}
            {context.lockedUntil && (
              <form
                action={async () => {
                  'use server';
                  await updatePeriodLock(orgSlug, { lockedUntil: null });
                  redirect(`/${orgSlug}/settings/general?saved=lock#lock`);
                }}
              >
                <button type="submit" className="btn-danger">
                  {t.settings.lockRemove}
                </button>
              </form>
            )}
          </div>
        </section>
      )}
    </>
  );
}
