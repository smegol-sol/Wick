# محرك WICK: الوثيقة المعمارية

المدخلات التي بُنيت عليها: رأس مال ابتدائي 2,500 دولار (نحو 24 SOL عند 101 دولار)، حفظ على VPS بمفتاح مختوم (ADR-0003)، وضعا اقتراح وتلقائي (ADR-0004)، وأسلوب دخول بعد التأكيد مع قنص الهجرة كخيار. المرجع المنهجي: The Meme Coin Handbook، خصوصاً الفصول 6 و8 و9 و12 و16 و19 و23.

## 1. الشكل العام

```
[pump.fun]  [DexScreener]  [Helius webhooks/WS]  [RPC]          [Jupiter]
     \            |               |                 |               |
      v           v               v                 v               |
   +------------------ ingest (Node worker) --------------+         |
   |  يكتب لقطات وأحداث إلى Postgres/Timescale وRedis streams |         |
   +---------------------------+---------------------------+         |
                               v                                     |
   +------------- features --------------+                           |
   | لكل mint كل ثانية: سيولة، حاملون،  |                           |
   | top10، تدفّق المحافظ، عمر، نسب     |                           |
   +---------------------------+---------+                           |
                               v                                     |
   +------------- decision (نقي، بلا شبكة) ----------+               |
   | قواعد بأوزان -> نية (intent)، لا معاملة          |               |
   +---------------------------+----------------------+              |
                               v                                     |
   +------------- gates (بالترتيب، أول رفض ينهي) -----+              |
   | safety -> liquidity -> manipulation -> quote ->  |<------------+
   | risk -> execution                                |
   +---------------------------+----------------------+
                               v
   +------------- executor -------------------------------+
   | simulate -> sign (مفتاح في الذاكرة) -> send -> confirm |
   | -> يقرأ الأرصدة قبل/بعد من السلسلة ويكتب fill        |
   +---------------------------+---------------------------+
                               v
   +------------- evaluator (يومي + كل 5 دقائق) -----------+
   | نتائج النوايا بعد 5/30/120 د، إحصاءات القواعد،        |
   | أوزان جديدة بسبب مسجّل، خفض رتبة محافظ                |
   +---------------------------------------------------------+

   [dashboard = تطبيق WICK الحالي] يقرأ من Postgres، يوافق على النوايا،
   يفتح الخزنة، يضغط الإيقاف. لا يوقّع بنفسه.
```

الخدمات كلها في عملية Node واحدة في البداية (وحدات منفصلة بعقود واضحة)، تُفصل إلى عمليات عند الحاجة. Postgres هو مصدر الحقيقة، Redis للتمرير الفوري فقط.

## 2. العقود بين المكوّنات

الأنواع أدناه هي عقود ثابتة؛ أي تغيير فيها يمر بـ ADR.

```ts
// ما يراه المحرك عن عملة لحظة القرار. null = لم يبلّغ أحد.
type Features = {
  mint: string;
  ts: number;
  ageSec: number;
  stage: "new" | "bonding" | "migrated";
  priceUsd: number;
  mcUsd: number;
  liqUsd: number;
  vol5m: number | null;
  vol24: number | null;
  tx24: number | null;
  buys5m: number | null;
  sells5m: number | null;
  uniqueBuyers5m: number | null;
  holders: number | null;
  top10Pct: number | null;
  authorities: { mint: boolean; freeze: boolean; program: "token" | "token2022" } | null;
  extensions: {
    transferFeeBps: number;
    hook: boolean;
    permanentDelegate: boolean;
    defaultFrozen: boolean;
  } | null;
  lp: "burned" | "locked" | "deployer" | "curve" | null;
  washFlags: string[];
  fundingFlags: string[];
  followBuys3m: number;
  followSells3m: number;
};

type Intent = {
  id: string;
  ts: number;
  kind: "entry" | "exit" | "add";
  strategy: "confirmed-entry" | "migration-snipe" | "mirror-follow" | "exit-policy";
  ruleId: string;
  mode: "suggest" | "auto";
  mint: string;
  side: "buy" | "sell";
  sizeSol: number; // بعد الوزن، قبل بوابة الخطر
  features: Features; // لقطة كاملة لحظة القرار
  why: string; // جملة واحدة تُعرض للمشغّل
  ttlMs: number; // 90000 في suggest
};

type GateResult = { gate: Gate; passed: boolean; reasonCode: ReasonCode | null; ms: number };

type Execution = {
  intentId: string;
  quoteId: string;
  sig: string | null;
  sentAt: number;
  landedAt: number | null;
  status: "simulated" | "sent" | "confirmed" | "failed" | "expired";
  err: string | null;
  feeLamports: number;
  tipLamports: number;
};

type Fill = {
  executionId: string;
  mint: string;
  side: "buy" | "sell";
  solDelta: number;
  tokenDelta: number; // من preBalances/postBalances، لا من الاقتباس
  quotedPrice: number;
  realizedPrice: number;
  realizedSlippagePct: number;
};

type Outcome = {
  intentId: string;
  horizonSec: 300 | 1800 | 7200;
  retPct: number;
  maxRetPct: number;
  minRetPct: number;
};
```

قنوات Redis streams: `market.snapshot`، `wallet.print`، `chain.event` (إنشاء/هجرة/LP)، `intent.proposed`، `intent.decided`، `execution.result`. كل رسالة تحمل `ts` و`source` و`schemaVersion`.

## 3. البوابات وأكواد الرفض

الترتيب ثابت. أول رفض ينهي الدورة ويُكتب في `gate_results`. توزيع أكواد الرفض هو أهم تشخيص في النظام.

| البوابة      | يرفض عند                                                                                  | الكود              |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------ |
| safety       | mint authority قائمة بعد الهجرة                                                           | `SAFETY_MINT`      |
| safety       | freeze authority قائمة                                                                    | `SAFETY_FREEZE`    |
| safety       | Token-2022 مع hook أو permanent delegate أو default frozen أو رسوم تحويل > 0              | `SAFETY_EXT`       |
| safety       | LP بيد المطوّر، أو "مقفل" بلا مدة ومقفِل قابلين للتحقق                                    | `SAFETY_LP`        |
| safety       | الصلاحيات أو الامتدادات `null` في وضع auto                                                | `SAFETY_UNKNOWN`   |
| liquidity    | الحجم > 1% من سيولة المسبح بالدولار                                                       | `LIQ_DEPTH`        |
| liquidity    | أثر الخروج المقدّر بكامل الحجم > 5%                                                       | `LIQ_EXIT`         |
| manipulation | vol24/liq خارج [0.05، 20] أو مشترون فريدون < 15 مع حجم يوحي بأكثر                         | `MANIP_WASH`       |
| manipulation | top10 > 35% (أو `null` في auto)                                                           | `MANIP_TOP10`      |
| manipulation | أكبر الحاملين من مموّل مشترك (المرحلة 4)                                                  | `MANIP_FUNDING`    |
| quote        | عمر الاقتباس > 3 ثوانٍ                                                                    | `QUOTE_STALE`      |
| quote        | الأثر السعري > 3% دخولاً أو > 5% خروجاً (Jupiter يعيده كسراً، يُحوَّل مرة واحدة إلى نسبة) | `QUOTE_IMPACT`     |
| risk         | الإيقاف مفعّل، أو خسارة اليوم ≥ 5%، أو الأسبوع ≥ 10%                                      | `RISK_HALT`        |
| risk         | مراكز مفتوحة ≥ 6                                                                          | `RISK_SLOTS`       |
| risk         | تعرّض العملة الواحدة > 3% من حقوق الملكية                                                 | `RISK_TOKEN_CAP`   |
| risk         | عملتان من نفس الموضوع مفتوحتان                                                            | `RISK_CLUSTER`     |
| risk         | رصيد التشغيل بعد الصفقة < احتياطي الرسوم 0.05 SOL                                         | `RISK_CASH`        |
| execution    | فشل `simulateTransaction`                                                                 | `EXEC_SIM`         |
| execution    | انتهى blockhash قبل الإرسال                                                               | `EXEC_EXPIRED`     |
| execution    | لم تُؤكَّد خلال 60 ثانية                                                                  | `EXEC_UNCONFIRMED` |

## 4. أرقام الخطر المشتقّة من 2,500 دولار

الكتاب يترك الأرقام للمشغّل عمداً؛ هذه اختياراتي، وكلها في ملف `risk.yaml` لا في الكود:

| البند              | القيمة                                                    | السبب                                                           |
| ------------------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| محفظة التنفيذ      | 15 SOL كحد أقصى، تُعبّأ يدوياً                            | الباقي بعيد عن أي برمجية                                        |
| حجم الصفقة         | 1.5% من حقوق الملكية (~0.35 SOL)                          | fixed fractional؛ عشرون خسارة متتالية تُبقيك في اللعبة          |
| الحد الأدنى للصفقة | 0.05 SOL                                                  | تحته الرسوم تأكل الصفقة                                         |
| أقصى مراكز مفتوحة  | 6                                                         | الارتباط بين عملات الميم أعلى مما يبدو                          |
| أقصى تعرّض لعملة   | 3%                                                        | إضافتان كحد أقصى                                                |
| وقف يومي           | 5% خسارة → توقف كل الدخول                                 | يُرفع يدوياً                                                    |
| وقف أسبوعي         | 10% → توقف + عودة كل القواعد إلى suggest                  |                                                                 |
| سلسلة خسائر        | 4 → القاعدة إلى suggest                                   |                                                                 |
| رسوم الأولوية      | ديناميكية من `getRecentPrioritizationFees`، سقف 0.002 SOL |                                                                 |
| ميزانية البنية     | ≤ 70 دولار شهرياً                                         | 2.8% من رأس المال شهرياً، وهذا هو الحد الأدنى للعائد قبل أي ربح |

نتيجة صريحة من هذه الأرقام: قنص ثانية الإطلاق مستبعد. تكلفة الوصول إليه (بث gRPC، رسوم Jito على الفشل أيضاً) تفوق ما يحتمله هذا الحجم. الدخول الافتراضي بعد التأكيد، وقنص الهجرة يعمل عبر webhook بحجم نصف الحجم الاعتيادي وبوضع suggest حتى يثبت.

## 5. الاستراتيجيات في الإصدار الأول

**confirmed-entry** (الافتراضية): عمر 3 إلى 90 دقيقة، سيولة ≥ 4,000 دولار، الصلاحيات ملغاة وبلا امتدادات خطرة، top10 ≤ 35%، buys5m/sells5m ≥ 1.3 مع ≥ 20 عملية، vol5m/liq داخل [0.05، 2]، مشترون فريدون ≥ 15، بلا علم غسل. شراء محفظة متابَعة خلال 3 دقائق يرفع الوزن. الخروج: وقف متحرك 22%، سلّم جني أرباح، خروج عند هبوط 18% في استطلاع واحد، خروج زمني بعد 4 ساعات، خروج عند انخفاض السيولة 30%.

**migration-snipe** (اختيارية): تُفعَّل من حدث الهجرة عبر webhook، نفس بوابة الأمان، حجم 50%، وضع suggest.

**mirror-follow**: كما في المكتب الحالي لكن على webhooks بدل الاستطلاع، مع قياس فجوة النسخ لكل صفقة، وخفض رتبة المحفظة عندما تتجاوز تكلفة الفجوة والانزلاق ربحها على آخر 10 نسخ.

## 6. مخطط قاعدة البيانات (Postgres + TimescaleDB)

```sql
tokens(mint pk, symbol, name, creator, created_at, first_seen, stage)
token_snapshots(ts, mint, price, mc, liq, vol5m, vol24, tx24, buys5m, sells5m, holders, top10, source)  -- hypertable
audits(mint, at, program, mint_auth, freeze_auth, extensions jsonb, lp_state, top10, funding_flags jsonb)
wallets(pk pk, label, tracked_since, status, stats jsonb)
wallet_prints(sig pk, wallet, ts, seen_at, mint, side, sol, amount)          -- copy gap = seen_at - ts
intents(id pk, ts, kind, strategy, rule_id, mode, mint, side, size_sol, features jsonb, why, status, decided_by, decided_at)
gate_results(intent_id, gate, passed, reason_code, ms)
quotes(id pk, intent_id, ts, in_amount, out_amount, impact_pct, slippage_bps, route jsonb)
executions(id pk, intent_id, quote_id, sig, sent_at, landed_at, status, err, fee_lamports, tip_lamports)
fills(execution_id pk, mint, side, sol_delta, token_delta, quoted_price, realized_price, realized_slippage_pct)
positions(mint, opened_at, closed_at, cost_sol, qty, exits jsonb, realized_pnl_sol, status)
outcomes(intent_id, horizon_sec, ret_pct, max_ret_pct, min_ret_pct)          -- لكل نية، منفَّذة أو مرفوضة
rule_stats(rule_id, window_days, n, win_rate, expectancy, worst_dd, weight, changed_at, change_reason)
halts(ts, kind, reason, cleared_at, cleared_by)
events(ts, level, component, msg, data jsonb)                               -- hypertable، الاحتفاظ 90 يوماً
```

## 7. المقاييس (Prometheus، بادئة `wick_`)

بلا label لعنوان عملة أو محفظة أو توقيع أبداً؛ التفاصيل في `events`.

| المقياس                                     | النوع     |
| ------------------------------------------- | --------- |
| `wick_up`                                   | gauge     |
| `wick_source_heartbeat_age_seconds{source}` | gauge     |
| `wick_source_call_duration_seconds{source}` | histogram |
| `wick_slot_lag`                             | gauge     |
| `wick_decision_duration_seconds`            | histogram |
| `wick_send_duration_seconds`                | histogram |
| `wick_land_duration_seconds`                | histogram |
| `wick_attempts_total{outcome}`              | counter   |
| `wick_rejections_total{gate,reason}`        | counter   |
| `wick_realized_slippage_pct`                | histogram |
| `wick_copy_gap_seconds`                     | histogram |
| `wick_open_positions`                       | gauge     |
| `wick_realized_pnl_sol_day`                 | gauge     |
| `wick_halted{kind}`                         | gauge     |

لوحتان فقط: Operations (حيّ؟) وQuality (يعمل؟). التنبيهات للحياة والبنية فقط؛ الفرامل في الكود.

## 8. ما ينتقل من الكود الحالي

`risk.ts` و`exits.ts` و`entry.ts` و`guard.ts` و`hot-wallet.ts` (صيغة الخزنة والموقّع) و`jup.ts` تنتقل كما هي إلى حزمة مشتركة `packages/core`. `live-auto.ts` يصير `executor`. المتجر في المتصفح يفقد التنفيذ ويصير عميل قراءة وموافقة.
