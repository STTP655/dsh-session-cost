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
		/** 峰谷价格（2026-08-17 00:00 北京时间起生效）。 */
		const TIERED_PRICES = {
			flash: { peak: { hit: 0.1, miss: 3, out: 9 }, off: { hit: 0.05, miss: 1.5, out: 4.5 } },
			pro: { peak: { hit: 0.3, miss: 9, out: 27 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } }
		};
		/** 2026-08-17 00:00 北京时间 = 2026-08-16 16:00 UTC。 */
		const NEW_PRICING_AT = Date.UTC(2026, 7, 16, 16, 0, 0);
		/** 默认模型（会话可切换模型，v1 按 flash 估算，见 README）。 */
		const DEFAULT_MODEL = "flash";

		/** 高峰时段：北京时间 9:00-12:00、14:00-18:00。 */
		function isPeakBeijing(now) {
			const bj = new Date(now.getTime() + 8 * 3600e3);
			const t = bj.getUTCHours() + bj.getUTCMinutes() / 60;
			return (t >= 9 && t < 12) || (t >= 14 && t < 18);
		}

		/**
		 * 计算一次估算费用（元）。
		 * 计费口径：缓存写入按"未命中"单价计（对应官方 prompt_cache_miss_tokens）；
		 * 结果 = (未命中 + 写入) × miss + 命中 × hit + 输出 × out。
		 * @param usage - tokenUsage 投影（uncachedInputTokens / cacheReadTokens / cacheWriteTokens / outputTokens）。
		 * @param model - flash | pro；默认 flash。
		 * @param now - 可注入时间（测试用）。
		 * @returns {total, hit, miss, out} 各部分费用（元）。
		 */
		function computeCost(usage, model, now) {
			model = model || DEFAULT_MODEL;
			now = now || new Date();
			let price;
			if (now.getTime() < NEW_PRICING_AT) price = FLAT_PRICES[model];
			else price = TIERED_PRICES[model][isPeakBeijing(now) ? "peak" : "off"];
			const hit = usage.cacheReadTokens * price.hit;
			const miss = (usage.uncachedInputTokens + usage.cacheWriteTokens) * price.miss;
			const out = usage.outputTokens * price.out;
			return {
				total: (hit + miss + out) / 1e6,
				hit: hit / 1e6,
				miss: miss / 1e6,
				out: out / 1e6
			};
		}

		/** 会话还没有任何计费 token 时返回 null（投影缺失或全零）。 */
		function billedTotal(usage) {
			if (typeof usage !== "object" || usage === null) return null;
			const sum = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0);
			return sum > 0 ? sum : null;
		}

		/** 测试钩子。 */
		const internals = { FLAT_PRICES, TIERED_PRICES, NEW_PRICING_AT, DEFAULT_MODEL, computeCost, isPeakBeijing, billedTotal };

		// ------------------------------------------------------------------
		// 组件 + 注册
		// ------------------------------------------------------------------

		/** 中文文案（与官方价格页口径一致）。 */
		const zh = {
			"label": "费用 ≈¥{amount}",
			"title": "估算 ¥{amount}（缓存命中 ¥{hit} · 未命中 ¥{miss} · 输出 ¥{out}）"
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"label": "Cost ≈¥{amount}",
			"title": "≈¥{amount} (cache hit ¥{hit} · miss ¥{miss} · output ¥{out})"
		};

		/**
		 * 统计条（conversation.composer.dock）里的费用条目。
		 * 只读框架标准 props：useProjection（投影读取钩子）与 t（本命名空间文案）。
		 */
		function CostChip(props) {
			const useProjection = props.useProjection;
			const t = props.t;
			const usage = useProjection("tokenUsage");
			const billed = billedTotal(usage);
			if (billed === null) return null;
			const parts = computeCost(usage);
			if (!(parts.total > 0)) return null;
			return react_jsx_runtime.jsx("span", {
				className: "dsh-session-cost-chip",
				title: t("title", {
					amount: parts.total.toFixed(2),
					hit: parts.hit.toFixed(2),
					miss: parts.miss.toFixed(2),
					out: parts.out.toFixed(2)
				}),
				children: t("label", { amount: parts.total.toFixed(2) })
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
