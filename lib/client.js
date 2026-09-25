window.__ModuleLoader__.load({
	id: "dsh-session-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

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
		// 分时段累加器
		//
		// tokenUsage 投影只有累计值、没有时间维度，所以按固定间隔采样，取相邻两次
		// 的快照差作为该区间的用量，并按采样时刻的档位单价记账。真实账单按每次请求
		// 发生的瞬间计价，因此误差只出在跨档位的那一个采样周期里：该周期产生的用量
		// 会被整块归到采样时刻的档位，故周期越短越准。
		// ------------------------------------------------------------------

		/**
		 * 采样间隔（毫秒）。1 分钟既是够用的精度（跨档位时最多错 1 分钟的用量），
		 * 也正好是浏览器对后台标签页定时器的节流下限，再细在后台也无意义。
		 */
		const SAMPLE_INTERVAL_MS = 60 * 1000;

		/** localStorage 键前缀；每个会话一份状态。 */
		const STORAGE_PREFIX = "dsh-session-cost:v1:";

		/** 落盘节流窗口（毫秒）：投影变化远比需要持久化的次数多。 */
		const PERSIST_THROTTLE_MS = 5000;

		/** 只取计费相关的四个计数，避免把选中的其它字段一起存进状态。 */
		function usageSnapshot(usage) {
			return {
				uncachedInputTokens: usage.uncachedInputTokens || 0,
				cacheReadTokens: usage.cacheReadTokens || 0,
				cacheWriteTokens: usage.cacheWriteTokens || 0,
				outputTokens: usage.outputTokens || 0
			};
		}

		/** 三档的空账本；每档记 命中 / 未命中（含缓存写入）/ 输出，单位与 token×单价一致。 */
		function emptyTiers() {
			return {
				peak: { hit: 0, miss: 0, out: 0 },
				off: { hit: 0, miss: 0, out: 0 },
				flat: { hit: 0, miss: 0, out: 0 }
			};
		}

		/**
		 * 没有历史采样记录时（首次使用、换浏览器、localStorage 被清）初始化一份状态：
		 * 把已发生的用量整块记到当前档位，得到与旧算法一致的数字，避免从 0 跳变。
		 */
		function initialAccumulator(usage, now, model) {
			const tiers = emptyTiers();
			const tier = tierAt(now);
			const price = priceFor(tier, model);
			const snap = usageSnapshot(usage);
			tiers[tier].hit = snap.cacheReadTokens * price.hit;
			tiers[tier].miss = (snap.uncachedInputTokens + snap.cacheWriteTokens) * price.miss;
			tiers[tier].out = snap.outputTokens * price.out;
			return { v: 1, model: model, last: snap, tiers: tiers };
		}

		/**
		 * 把采到的增量记到当前档位上。
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
			const bucket = state.tiers[tier];
			bucket.hit += delta.cacheReadTokens * price.hit;
			bucket.miss += (delta.uncachedInputTokens + delta.cacheWriteTokens) * price.miss;
			bucket.out += delta.outputTokens * price.out;
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

		/** 读取某会话的账本；缺失或结构不符时返回 undefined。 */
		function loadAccumulator(sessionId) {
			try {
				const raw = window.localStorage.getItem(STORAGE_PREFIX + sessionId);
				if (raw === null) return undefined;
				const parsed = JSON.parse(raw);
				if (typeof parsed !== "object" || parsed === null || parsed.v !== 1) return undefined;
				if (typeof parsed.last !== "object" || parsed.last === null) return undefined;
				if (typeof parsed.tiers !== "object" || parsed.tiers === null) return undefined;
				return parsed;
			} catch (error) {
				return undefined;
			}
		}

		/** 写入账本；localStorage 不可用（隐私模式、配额满）时返回 false，调用方继续走内存态。 */
		function saveAccumulator(sessionId, state) {
			try {
				window.localStorage.setItem(STORAGE_PREFIX + sessionId, JSON.stringify(state));
				return true;
			} catch (error) {
				return false;
			}
		}

		/**
		 * 计算一次估算费用（元）。
		 * 计费口径：缓存写入按"未命中"单价计（对应官方 prompt_cache_miss_tokens）；
		 * 结果 = (未命中 + 写入) × miss + 命中 × hit + 输出 × out。
		 * 本函数按单一时刻的档位计价，只用于没有会话账本时的兜底（无 sessionId、
		 * 或首个采样点之前）；正常路径走 accumulate + totalsOf。
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

		/** 测试钩子。 */
		const internals = {
			FLAT_PRICES, TIERED_PRICES, NEW_PRICING_AT, DEFAULT_MODEL, HOLIDAYS, PEAK_COLOR, OFF_COLOR,
			SAMPLE_INTERVAL_MS, STORAGE_PREFIX, PERSIST_THROTTLE_MS,
			isPeakBeijing, tierAt, priceFor, usageSnapshot, emptyTiers,
			initialAccumulator, accumulate, totalsOf, loadAccumulator, saveAccumulator,
			computeCost, billedTotal
		};

		// ------------------------------------------------------------------
		// 组件 + 注册
		// ------------------------------------------------------------------

		/** 中文文案：费用 + 三项明细，样式对齐官方统计条（12px / tertiary 色 / | 分隔）。 */
		const zh = {
			"label": "费用 ≈¥{amount}",
			"hit": "命中 ¥{amount}",
			"miss": "未命中 ¥{amount}",
			"out": "输出 ¥{amount}",
			"peak": "峰价",
			"off": "谷价"
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"label": "Cost ≈¥{amount}",
			"hit": "hit ¥{amount}",
			"miss": "miss ¥{amount}",
			"out": "output ¥{amount}",
			"peak": "peak",
			"off": "off-peak"
		};

		/**
		 * 统计条（conversation.composer.dock）里的费用条目。
		 * 展示总额 + 命中 / 未命中 / 输出三项明细，样式模仿官方 StatsLine：
		 * font-size 12px、color var(--dsw-alias-label-tertiary)、分隔符
		 * var(--dsw-alias-separator-primary) + 10px 边距（主题自适应变量）。
		 * 总额按分时段账本累计（见上），之后追加当前档位标记（峰价红 / 谷价绿）；
		 * 平峰价（2026-08-17 之前）不加标记。
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
			const box = react.useRef({ session: undefined, state: undefined, savedAt: 0 });
			const bump = react.useState(0)[1];

			/** 取当前会话的账本，必要时从 localStorage 恢复或新建。 */
			const ensure = () => {
				if (box.current.session !== sessionId) {
					box.current.session = sessionId;
					box.current.state = undefined;
					box.current.savedAt = 0;
				}
				if (box.current.state === undefined && billedTotal(usageRef.current) !== null) {
					const restored = sessionId === undefined ? undefined : loadAccumulator(sessionId);
					box.current.state = restored === undefined
						? initialAccumulator(usageRef.current, new Date(), DEFAULT_MODEL)
						: restored;
				}
				return box.current.state;
			};

			/** 采样一次并（节流地）落盘；force 用于定时器与卸载。 */
			const sample = (force) => {
				const state = ensure();
				if (state === undefined) return;
				accumulate(state, usageRef.current, new Date());
				const now = Date.now();
				if (!force && now - box.current.savedAt < PERSIST_THROTTLE_MS) return;
				box.current.savedAt = now;
				if (sessionId !== undefined) saveAccumulator(sessionId, state);
			};

			// 定时器只管采样与重渲染；账本里读的始终是 usageRef 的最新值。
			react.useEffect(() => {
				sample(true);
				const timer = setInterval(() => {
					sample(true);
					bump((n) => n + 1);
				}, SAMPLE_INTERVAL_MS);
				return () => {
					sample(true);
					clearInterval(timer);
				};
			}, [sessionId]);

			// 投影变化时立即采样（落盘走节流），让数字跟着用量走。
			react.useEffect(() => {
				sample(false);
			}, [usage]);

			const billed = billedTotal(usage);
			if (billed === null) return null;
			const state = box.current.state;
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

		/** Required services: the slot registry and the locale seat. */
		const inject = ["slots", "locale"];

		/** Client plugin body: register dictionaries and the dock entry. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register("session-cost", { zh, en }), "session-cost: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "session-cost",
				order: 100,
				locale: "session-cost"
			}, CostChip));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.internals = internals;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
