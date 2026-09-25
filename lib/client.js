window.__ModuleLoader__.load({
	id: "dsh-session-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		// Loader 把 ui-primitives 作为隐式 baseline external 提供，这里 require 到的
		// 就是 DSH 自己在用的那份组件，不额外打包副本；拿不到时降级为不注册详情入口。
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = undefined;
		}
		const Button = primitives === undefined ? undefined : primitives.Button;
		const Modal = primitives === undefined ? undefined : primitives.Modal;

		// ------------------------------------------------------------------
		// DeepSeek API pricing, CNY per 1M tokens
		// (https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
		// ------------------------------------------------------------------

		/** 平峰价格（2026-08-17 00:00 北京时间之前生效）。 */
		const FLAT_PRICES = {
			flash: { hit: 0.02, miss: 1, out: 2 },
			pro: { hit: 0.025, miss: 3, out: 6 }
		};
		/**
		 * 峰谷价格（2026-08-17 00:00 北京时间起生效）。
		 * flash 一档于本地维护时按 2026-09-25 官网页面校正（上游 0.1.3 仍是调价前的旧值）。
		 */
		const TIERED_PRICES = {
			flash: { peak: { hit: 0.04, miss: 2, out: 8 }, off: { hit: 0.02, miss: 1, out: 4 } },
			pro: { peak: { hit: 0.3, miss: 9, out: 27 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } }
		};
		/** 2026-08-17 00:00 北京时间 = 2026-08-16 16:00 UTC。 */
		const NEW_PRICING_AT = Date.UTC(2026, 7, 16, 16, 0, 0);
		/** 默认模型（会话可切换模型，v1 按 flash 估算，见 README）。 */
		const DEFAULT_MODEL = "flash";

		/**
		 * 2026 年中国法定节假日（北京时间日期，YYYY-MM-DD），依据国务院办公厅
		 * 《关于 2026 年部分节假日安排的通知》；假期期间全天按空闲（谷价）计。
		 * 调休补班的周末不在此列：官方价格页按星期定义时段（周末一律为空闲时段），未提及调休。
		 * 2027 年安排公布后（通常在上一年 11 月）需在此追加。
		 */
		const HOLIDAYS = new Set([
			"2026-01-01", "2026-01-02", "2026-01-03",
			"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
			"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
			"2026-04-04", "2026-04-05", "2026-04-06",
			"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
			"2026-06-19", "2026-06-20", "2026-06-21",
			"2026-09-25", "2026-09-26", "2026-09-27",
			"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
			"2026-10-06", "2026-10-07"
		]);

		/** 计价档位标识的配色：峰价红、谷价绿（深浅主题下都可读）。 */
		const PEAK_COLOR = "#e5484d";
		const OFF_COLOR = "#30a46c";

		/** 高峰时段：北京时间周一至周五、非周末、非法定节假日的 9:00-12:00 与 14:00-18:00；其余全部按空闲计。 */
		function isPeakBeijing(now) {
			const bj = new Date(now.getTime() + 8 * 3600e3);
			const t = bj.getUTCHours() + bj.getUTCMinutes() / 60;
			return bj.getUTCDay() !== 0 && bj.getUTCDay() !== 6 && !HOLIDAYS.has(bj.toISOString().slice(0, 10)) && ((t >= 9 && t < 12) || (t >= 14 && t < 18));
		}

		/** 给定时刻落在哪一档：峰价、谷价，或 2026-08-17 之前的平峰价。 */
		function tierAt(now) {
			return now.getTime() < NEW_PRICING_AT ? "flat" : (isPeakBeijing(now) ? "peak" : "off");
		}

		/** 某一档的单价表：平峰价只有一个档，峰谷价按 peak / off 分。 */
		function priceFor(tier, model) {
			return tier === "flat" ? FLAT_PRICES[model] : TIERED_PRICES[model][tier];
		}

		// ------------------------------------------------------------------
		// 分时段账本
		//
		// tokenUsage 投影只有累计值、没有时间维度，所以按固定间隔采样，取相邻两次
		// 的快照差作为该区间的用量，并按采样时刻的档位单价记账。真实账单按每次请求
		// 发生的瞬间计价，因此误差只出在跨档位的那一个采样周期里：该周期产生的用量
		// 会被整块归到采样时刻的档位，故周期越短越准。
		// 账本同时维护三档汇总（总额）与按小时分桶的明细（详情表）。
		// ------------------------------------------------------------------

		/**
		 * 采样间隔（毫秒）。1 分钟既是够用的精度（跨档位时最多错 1 分钟的用量），
		 * 也正好是浏览器对后台标签页定时器的节流下限，再细在后台也无意义。
		 */
		const SAMPLE_INTERVAL_MS = 60 * 1000;

		/** localStorage 键前缀；每个会话一份账本。 */
		const STORAGE_PREFIX = "dsh-session-cost:v1:";

		/** 落盘节流窗口（毫秒）：投影变化远比需要持久化的次数多。 */
		const PERSIST_THROTTLE_MS = 5000;

		/** 账本结构版本；不一致的旧账本会被丢弃并重新初始化。 */
		const LEDGER_VERSION = 2;

		/** 小时桶保留时长：最近 7 天，超出即丢，避免 localStorage 无限增长。 */
		const LEDGER_RETENTION_MS = 7 * 24 * 3600 * 1000;

		/** 内存账本：账本键 → 状态。 */
		const LEDGERS = new Map();

		/** 各账本上次落盘时间。 */
		const SAVED_AT = new Map();

		/** 账本键：会话 id 的字符串形式；没有会话时用一个空键。 */
		function ledgerKey(sessionId) {
			return sessionId === undefined ? "" : String(sessionId);
		}

		/** 只取计费相关的四个计数，避免把选中的其它字段一起存进账本。 */
		function usageSnapshot(usage) {
			return {
				uncachedInputTokens: usage.uncachedInputTokens || 0,
				cacheReadTokens: usage.cacheReadTokens || 0,
				cacheWriteTokens: usage.cacheWriteTokens || 0,
				outputTokens: usage.outputTokens || 0
			};
		}

		/** 三档的空汇总；每档记 命中 / 未命中（含缓存写入）/ 输出。 */
		function emptyTiers() {
			return {
				peak: { hit: 0, miss: 0, out: 0 },
				off: { hit: 0, miss: 0, out: 0 },
				flat: { hit: 0, miss: 0, out: 0 }
			};
		}

		/** 北京时间的整点键，YYYY-MM-DDTHH；ISO 前缀让字符串比较等价于时间比较。 */
		function hourKey(date) {
			return new Date(date.getTime() + 8 * 3600e3).toISOString().slice(0, 13);
		}

		/** 丢掉保留期外的小时桶。 */
		function pruneHours(state, now) {
			const cutoff = hourKey(new Date(now.getTime() - LEDGER_RETENTION_MS));
			for (const key of Object.keys(state.hours)) {
				if (key < cutoff) delete state.hours[key];
			}
		}

		/** 按时间倒序列出小时桶，供详情表使用（费用已换算成元）。 */
		function hourRows(state) {
			return Object.keys(state.hours).sort().reverse().map((key) => {
				const bucket = state.hours[key];
				return {
					hour: key,
					tier: bucket.tier,
					hitTokens: bucket.hit,
					missTokens: bucket.miss,
					outTokens: bucket.out,
					cost: bucket.cost / 1e6
				};
			});
		}

		/**
		 * 没有历史账本时（首次使用、换浏览器、localStorage 被清）初始化一份：
		 * 把已发生的用量整块记到当前档位与当前小时，得到与旧算法一致的数字，
		 * 避免从 0 跳变。
		 */
		function initialLedger(usage, now, model) {
			const snap = usageSnapshot(usage);
			const tier = tierAt(now);
			const price = priceFor(tier, model);
			const tiers = emptyTiers();
			tiers[tier].hit = snap.cacheReadTokens * price.hit;
			tiers[tier].miss = (snap.uncachedInputTokens + snap.cacheWriteTokens) * price.miss;
			tiers[tier].out = snap.outputTokens * price.out;
			const hours = {};
			hours[hourKey(now)] = {
				hit: snap.cacheReadTokens,
				miss: snap.uncachedInputTokens + snap.cacheWriteTokens,
				out: snap.outputTokens,
				cost: tiers[tier].hit + tiers[tier].miss + tiers[tier].out,
				tier: tier
			};
			return { v: LEDGER_VERSION, model: model, last: snap, tiers: tiers, hours: hours };
		}

		/**
		 * 把采到的增量记到当前档位与当前小时。
		 * 增量可能为负（会话切换、投影回退、日志重放），此时只对齐快照、不记账，
		 * 否则账本会被减成负数。
		 * @returns 本次是否记入了费用。
		 */
		function accumulate(state, usage, now) {
			const next = usageSnapshot(usage);
			const delta = {
				uncachedInputTokens: next.uncachedInputTokens - state.last.uncachedInputTokens,
				cacheReadTokens: next.cacheReadTokens - state.last.cacheReadTokens,
				cacheWriteTokens: next.cacheWriteTokens - state.last.cacheWriteTokens,
				outputTokens: next.outputTokens - state.last.outputTokens
			};
			state.last = next;
			const sum = delta.uncachedInputTokens + delta.cacheReadTokens + delta.cacheWriteTokens + delta.outputTokens;
			if (sum <= 0) return false;
			const tier = tierAt(now);
			const price = priceFor(tier, state.model || DEFAULT_MODEL);
			const missTokens = delta.uncachedInputTokens + delta.cacheWriteTokens;
			const hitCost = delta.cacheReadTokens * price.hit;
			const missCost = missTokens * price.miss;
			const outCost = delta.outputTokens * price.out;
			const bucket = state.tiers[tier];
			bucket.hit += hitCost;
			bucket.miss += missCost;
			bucket.out += outCost;
			const key = hourKey(now);
			let hour = state.hours[key];
			if (hour === undefined) {
				hour = { hit: 0, miss: 0, out: 0, cost: 0, tier: tier };
				state.hours[key] = hour;
			} else if (hour.tier !== tier) {
				hour.tier = "mixed";
			}
			hour.hit += delta.cacheReadTokens;
			hour.miss += missTokens;
			hour.out += delta.outputTokens;
			hour.cost += hitCost + missCost + outCost;
			pruneHours(state, now);
			return true;
		}

		/** 三档求和，得到 {total, hit, miss, out}（元），与 computeCost 的形状一致。 */
		function totalsOf(state) {
			const sum = { hit: 0, miss: 0, out: 0 };
			for (const tier of ["peak", "off", "flat"]) {
				const bucket = state.tiers[tier];
				if (bucket === undefined) continue;
				sum.hit += bucket.hit;
				sum.miss += bucket.miss;
				sum.out += bucket.out;
			}
			return {
				total: (sum.hit + sum.miss + sum.out) / 1e6,
				hit: sum.hit / 1e6,
				miss: sum.miss / 1e6,
				out: sum.out / 1e6
			};
		}

		/** 读取某会话的账本；缺失、版本不符或结构异常时返回 undefined。 */
		function loadLedger(sessionId) {
			try {
				const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionId);
				if (raw === null) return undefined;
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null || parsed.v !== LEDGER_VERSION) return undefined;
				if (typeof parsed.last !== "object" || parsed.last === null) return undefined;
				if (typeof parsed.tiers !== "object" || parsed.tiers === null) return undefined;
				if (typeof parsed.hours !== "object" || parsed.hours === null) parsed.hours = {};
				return parsed;
			} catch (error) {
				return undefined;
			}
		}

		/** 写入账本；localStorage 不可用（隐私模式、配额满）时返回 false，调用方继续走内存态。 */
		function saveLedger(sessionId, state) {
			try {
				window.localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(state));
				return true;
			} catch (error) {
				return false;
			}
		}

		/** 取会话账本：内存优先，其次 localStorage，最后按当前用量新建。 */
		function ledgerFor(sessionId, usage, now) {
			const key = ledgerKey(sessionId);
			const cached = LEDGERS.get(key);
			if (cached !== undefined) return cached;
			const restored = sessionId === undefined ? undefined : loadLedger(sessionId);
			const state = restored === undefined ? initialLedger(usage, now, DEFAULT_MODEL) : restored;
			LEDGERS.set(key, state);
			return state;
		}

		/**
		 * 采样一次并（节流地）落盘。
		 * @param sessionId - 会话标识；缺省时只走内存态。
		 * @param usage - 当次读到的 tokenUsage 投影。
		 * @param now - 采样时刻。
		 * @param force - 忽略落盘节流（定时器、投影变化后的首次、卸载时用）。
		 * @returns 该会话的账本，或 undefined（尚无计费 token）。
		 */
		function sampleLedger(sessionId, usage, now, force) {
			if (billedTotal(usage) === null) return undefined;
			const state = ledgerFor(sessionId, usage, now);
			accumulate(state, usage, now);
			const key = ledgerKey(sessionId);
			const last = SAVED_AT.get(key);
			if (!force && last !== undefined && now.getTime() - last < PERSIST_THROTTLE_MS) return state;
			SAVED_AT.set(key, now.getTime());
			if (sessionId !== undefined) saveLedger(sessionId, state);
			return state;
		}

		/**
		 * 计算一次估算费用（元）。
		 * 计费口径：缓存写入按"未命中"单价计（对应官方 prompt_cache_miss_tokens）；
		 * 结果 = (未命中 + 写入) × miss + 命中 × hit + 输出 × out。
		 * 本函数按单一时刻的档位计价，只用于账本尚未建立时的兜底；正常路径走
		 * accumulate + totalsOf。
		 * @param usage - tokenUsage 投影（uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens）。
		 * @param model - flash | pro；默认 flash。
		 * @param now - 可注入时间（测试用）。
		 * @returns {total, hit, miss, out, tier} 各部分费用（元）与计价档位（peak | off | flat）。
		 */
		function computeCost(usage, model, now) {
			model = model || DEFAULT_MODEL;
			now = now || new Date();
			const tier = tierAt(now);
			const price = priceFor(tier, model);
			const hit = usage.cacheReadTokens * price.hit;
			const miss = (usage.uncachedInputTokens + usage.cacheWriteTokens) * price.miss;
			const out = usage.outputTokens * price.out;
			return {
				total: (hit + miss + out) / 1e6,
				hit: hit / 1e6,
				miss: miss / 1e6,
				out: out / 1e6,
				tier: tier
			};
		}

		/** 会话还没有任何计费 token 时返回 null（投影缺失或全零）。 */
		function billedTotal(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			const sum = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0);
			return sum > 0 ? sum : null;
		}

		/** 紧凑 token 计数：1234 → 1.2k，1234567 → 1.23M。 */
		function formatTokens(n) {
			if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
			return String(n);
		}

		/** 由 YYYY-MM-DDTHH 得到 "MM-DD HH:00"（北京时间的整点标签）。 */
		function hourLabel(key) {
			return key.slice(5, 10) + " " + key.slice(11, 13) + ":00";
		}

		/** 测试钩子。 */
		const internals = {
			FLAT_PRICES, TIERED_PRICES, NEW_PRICING_AT, DEFAULT_MODEL, HOLIDAYS, PEAK_COLOR, OFF_COLOR,
			SAMPLE_INTERVAL_MS, STORAGE_PREFIX, PERSIST_THROTTLE_MS, LEDGER_VERSION, LEDGER_RETENTION_MS,
			isPeakBeijing, tierAt, priceFor, usageSnapshot, emptyTiers, hourKey, pruneHours, hourRows,
			initialLedger, accumulate, totalsOf, loadLedger, saveLedger, ledgerFor, sampleLedger,
			computeCost, billedTotal, formatTokens, hourLabel, LEDGERS
		};

		// ------------------------------------------------------------------
		// 组件 + 注册
		// ------------------------------------------------------------------

		/** 中文文案：底部条目 + 头部详情入口 + 详情表。 */
		const zh = {
			"label": "费用 ≈¥{amount}",
			"hit": "命中 ¥{amount}",
			"miss": "未命中 ¥{amount}",
			"out": "输出 ¥{amount}",
			"peak": "峰价",
			"off": "谷价",
			"flat": "平峰",
			"mixed": "跨档",
			"detail": "费用",
			"detailTitle": "本会话费用明细",
			"close": "关闭",
			"colTime": "时间",
			"colTier": "档位",
			"colHit": "命中",
			"colMiss": "未命中",
			"colOut": "输出",
			"colCost": "费用",
			"total": "合计",
			"noData": "还没有可展示的用量记录。",
			"hint": "按小时聚合，保留最近 7 天；金额为估算值（≈）。"
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"label": "Cost ≈¥{amount}",
			"hit": "hit ¥{amount}",
			"miss": "miss ¥{amount}",
			"out": "output ¥{amount}",
			"peak": "peak",
			"off": "off-peak",
			"flat": "flat",
			"mixed": "mixed",
			"detail": "Cost",
			"detailTitle": "Session cost breakdown",
			"close": "Close",
			"colTime": "Hour",
			"colTier": "Rate",
			"colHit": "Hit",
			"colMiss": "Miss",
			"colOut": "Output",
			"colCost": "Cost",
			"total": "Total",
			"noData": "No usage recorded yet.",
			"hint": "Aggregated by hour, last 7 days kept; amounts are estimates (≈)."
		};

		/**
		 * 统计条（conversation.composer.dock）里的费用条目。
		 * 展示总额 + 命中 / 未命中 / 输出三项明细，样式模仿官方 StatsLine：
		 * font-size 12px、color var(--dsw-alias-label-tertiary)、分隔符
		 * var(--dsw-alias-separator-primary) + 10px 边距（主题自适应变量）。
		 * 总额取自分时段账本（跨峰谷时按各段单价计），之后追加当前档位标记
		 * （峰价红 / 谷价绿）；平峰价（2026-08-17 之前）不加标记。
		 * 座位是 scope: 'session'，因此拿到 sessionId 用于账本分键。
		 * 其余只读框架标准 props：useProjection（投影读取钩子）与 t（本命名空间文案）。
		 */
		function CostChip(props) {
			const useProjection = props.useProjection;
			const t = props.t;
			const sessionId = props.sessionId;
			const usage = useProjection("tokenUsage");
			const usageRef = react.useRef(usage);
			usageRef.current = usage;
			const bump = react.useState(0)[1];

			// 定时器只管采样与重渲染；账本里读的始终是 usageRef 的最新值。
			react.useEffect(() => {
				sampleLedger(sessionId, usageRef.current, new Date(), true);
				const timer = setInterval(() => {
					sampleLedger(sessionId, usageRef.current, new Date(), true);
					bump((n) => n + 1);
				}, SAMPLE_INTERVAL_MS);
				return () => {
					sampleLedger(sessionId, usageRef.current, new Date(), true);
					clearInterval(timer);
				};
			}, [sessionId]);

			// 投影变化时立即采样（落盘走节流），让数字跟着用量走。
			react.useEffect(() => {
				sampleLedger(sessionId, usageRef.current, new Date(), false);
			}, [usage]);

			const billed = billedTotal(usage);
			if (billed === null) return null;
			const state = LEDGERS.get(ledgerKey(sessionId));
			const parts = state === undefined ? computeCost(usage) : totalsOf(state);
			if (!(parts.total > 0)) return null;
			const tier = tierAt(new Date());
			const tierColor = tier === "peak" ? PEAK_COLOR : OFF_COLOR;
			const fmt = (n) => n.toFixed(2);
			const groups = [
				t("label", { amount: fmt(parts.total) }),
				t("hit", { amount: fmt(parts.hit) }),
				t("miss", { amount: fmt(parts.miss) }),
				t("out", { amount: fmt(parts.out) })
			];
			const sep = (0, react_jsx_runtime.jsx)("span", {
				style: { color: "var(--dsw-alias-separator-primary)", margin: "0 10px" },
				"aria-hidden": true,
				children: "|"
			});
			return (0, react_jsx_runtime.jsx)("div", {
				style: {
					textAlign: "center",
					boxSizing: "border-box",
					color: "var(--dsw-alias-label-tertiary)",
					whiteSpace: "nowrap",
					textOverflow: "ellipsis",
					overflow: "hidden",
					fontSize: 12,
					lineHeight: "20px",
					padding: "2px calc(var(--dsh-composer-side-clearance) + 16px) 0"
				},
				children: groups.map((group, i) => (0, react_jsx_runtime.jsxs)(react.Fragment, {
					children: [
						i > 0 && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, {
							children: [sep, " "]
						}),
						(0, react_jsx_runtime.jsx)("span", { children: group }),
						i === 0 && tier !== "flat" && (0, react_jsx_runtime.jsx)("span", {
							style: { color: tierColor, marginLeft: 6 },
							children: "· " + t(tier)
						})
					]
				}, group))
			});
		}

		/** 详情表的一个单元格；数值列右对齐。 */
		function cell(value, extra) {
			return (0, react_jsx_runtime.jsx)("td", {
				style: Object.assign({
					padding: "5px 8px",
					borderBottom: "1px solid var(--dsw-alias-separator-primary)",
					textAlign: "right",
					whiteSpace: "nowrap"
				}, extra),
				children: value
			});
		}

		/** 详情表的表头单元格。 */
		function head(value) {
			return (0, react_jsx_runtime.jsx)("th", {
				style: {
					padding: "5px 8px",
					borderBottom: "1px solid var(--dsw-alias-separator-primary)",
					textAlign: "right",
					fontWeight: 500,
					color: "var(--dsw-alias-label-secondary)"
				},
				children: value
			});
		}

		/**
		 * 会话头部右上角（conversation.session.header.corner）的「费用」入口。
		 * 点开是一个原生 Modal（毛玻璃遮罩），按小时列出本会话的 token 用量与费用；
		 * 数据来自与底部条目同一个分时段账本，保留最近 7 天。
		 * 座位是 scope: 'session'，因此拿到 sessionId 取对应账本。
		 */
		function CostDetail(props) {
			const t = props.t;
			const sessionId = props.sessionId;
			const useProjection = props.useProjection;
			const opened = react.useState(false);
			const open = opened[0];
			const setOpen = opened[1];
			const bump = react.useState(0)[1];
			// corner 座位不保证带 standard kit；有投影钩子就顺带采样，没有就只读已有账本。
			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;

			react.useEffect(() => {
				if (!open) return undefined;
				if (typeof useProjection === "function") sampleLedger(sessionId, usage, new Date(), true);
				const timer = setInterval(() => bump((n) => n + 1), SAMPLE_INTERVAL_MS);
				return () => clearInterval(timer);
			}, [open, sessionId]);

			const state = LEDGERS.get(ledgerKey(sessionId));
			const rows = state === undefined ? [] : hourRows(state);
			const parts = state === undefined ? undefined : totalsOf(state);
			const tierText = (tier) => (tier === "peak" || tier === "off" || tier === "mixed" || tier === "flat") ? t(tier) : tier;
			const tierColor = (tier) => tier === "peak" ? PEAK_COLOR : (tier === "off" ? OFF_COLOR : "var(--dsw-alias-label-secondary)");
			const summary = parts === undefined || parts.total <= 0
				? t("noData")
				: t("total") + " ≈¥" + parts.total.toFixed(2)
					+ "  ·  " + t("hit", { amount: parts.hit.toFixed(2) })
					+ "  ·  " + t("miss", { amount: parts.miss.toFixed(2) })
					+ "  ·  " + t("out", { amount: parts.out.toFixed(2) });
			const body = (0, react_jsx_runtime.jsxs)("div", {
				style: { fontSize: 12, color: "var(--dsw-alias-label-primary)" },
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						style: { padding: "0 0 10px", color: "var(--dsw-alias-label-secondary)" },
						children: summary
					}),
					(0, react_jsx_runtime.jsxs)("table", {
						style: { width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" },
						children: [
							(0, react_jsx_runtime.jsx)("thead", {
								children: (0, react_jsx_runtime.jsxs)("tr", {
									children: [
										head(t("colTime")),
										head(t("colTier")),
										head(t("colHit")),
										head(t("colMiss")),
										head(t("colOut")),
										head(t("colCost"))
									]
								})
							}),
							(0, react_jsx_runtime.jsx)("tbody", {
								children: rows.map((row) => (0, react_jsx_runtime.jsxs)("tr", {
									children: [
										cell(hourLabel(row.hour), { textAlign: "left", color: "var(--dsw-alias-label-secondary)" }),
										cell(tierText(row.tier), { color: tierColor(row.tier) }),
										cell(formatTokens(row.hitTokens)),
										cell(formatTokens(row.missTokens)),
										cell(formatTokens(row.outTokens)),
										cell("¥" + row.cost.toFixed(4))
									]
								}, row.hour))
							})
						]
					}),
					(0, react_jsx_runtime.jsx)("div", {
						style: { padding: "10px 0 0", color: "var(--dsw-alias-label-tertiary)" },
						children: t("hint")
					})
				]
			});
			return (0, react_jsx_runtime.jsxs)(react.Fragment, {
				children: [
					(0, react_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => setOpen(true),
						children: t("detail")
					}),
					(0, react_jsx_runtime.jsx)(Modal, {
						open: open,
						onClose: () => setOpen(false),
						title: t("detailTitle"),
						closeLabel: t("close"),
						children: body
					})
				]
			});
		}

		/** Required services: the slot registry and the locale seat. */
		const inject = ["slots", "locale"];

		/** Client plugin body: register dictionaries, the dock entry, and the header detail entry. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("session-cost", { zh, en }), "session-cost: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "session-cost",
				order: 100,
				locale: "session-cost"
			}, CostChip));
			// 头部入口依赖原生 Button / Modal；拿不到组件时不注册，底部条目照常工作。
			if (Button !== undefined && Modal !== undefined) {
				ctx.slots.inject("conversation.session.header.corner", () => ctx.slots.register({
					name: "conversation.session.header.corner",
					id: "session-cost-detail",
					order: 100,
					locale: "session-cost"
				}, CostDetail));
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.internals = internals;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
