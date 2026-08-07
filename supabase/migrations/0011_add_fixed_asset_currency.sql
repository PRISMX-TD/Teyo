-- 为 fixed_assets 添加原币记录字段（仅作审计留痕）
-- 所有折旧计算继续使用 cost_minor（基准币种）

alter table fixed_assets
  add column original_currency char(3),
  add column original_cost_minor bigint,
  add column purchase_exchange_rate numeric(20, 8);

comment on column fixed_assets.original_currency is '购入币种（留痕），为空表示直接按基准币种记账';
comment on column fixed_assets.original_cost_minor is '原币金额（留痕），单位为该币种的最小单位';
comment on column fixed_assets.purchase_exchange_rate is '购入日汇率（留痕），1 单位原币 = ? 单位基准币种';
