/**
 * 地址栏里的 id 段是不是一个 uuid。
 *
 * 详情页（/bills/<id>、/invoices/<id>/print……）把 params.id 原样交给 SQL。
 * 一个随手改坏的 id（`/bills/abc`、被截断的链接）在 Postgres 那边是
 * invalid_text_representation，整页变成 500 和一串 digest，而它本该和
 * 「查不到」一样是 404。页面在查库之前先用这个挡一下。
 *
 * 不限定版本位：库里的 id 由 gen_random_uuid() 生成（v4），但种子与测试
 * 数据里有手写的固定 uuid，Postgres 的 uuid 类型本身也不校验版本。
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
