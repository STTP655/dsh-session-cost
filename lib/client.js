window.__ModuleLoader__.load({
	id: "dsh-session-cost",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		// ui-primitives 由 Loader 作为隐式 baseline external 提供（DSH 自己那份，不额外打包）；
		// 拿不到时只降级掉头部入口，底部条目照常工作。
		let primitives;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch (error) {
			primitives = undefined;
		}
		const Button = primitives === undefined ? undefined : primitives.Button;
		// 弹窗自绘（原生 Modal 没有退场动画、宽度锁死 380px），只用 portal 挂到 body。
		let createPortal;
		try {
			const reactDom = require("react-dom");
			createPortal = reactDom === undefined ? undefined : reactDom.createPortal;
		} catch (error) {
			createPortal = undefined;
		}

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

		/** 计价档位标识的配色：峰价红、谷价绿。 */
		const PEAK_COLOR = "#e5484d";
		const OFF_COLOR = "#30a46c";
		const FLAT_COLOR = "#8b8d98";
		const MIXED_COLOR = "#f5a524";

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

		/** 档位配色。 */
		function colorOf(tier) {
			if (tier === "peak") return PEAK_COLOR;
			if (tier === "off") return OFF_COLOR;
			if (tier === "mixed") return MIXED_COLOR;
			return FLAT_COLOR;
		}

		// ------------------------------------------------------------------
		// 分时段账本
		//
		// tokenUsage 投影只有累计值、没有时间维度，所以按固定间隔采样，取相邻两次
		// 的快照差作为该区间的用量，并按采样时刻的档位单价记账。真实账单按每次请求
		// 发生的瞬间计价，因此误差只出在跨档位的那一个采样周期里：该周期产生的用量
		// 会被整块归到采样时刻的档位，故周期越短越准。
		// 账本维护三档汇总（总额）与按小时分桶的明细（详情面板：24 小时内按小时、
		// 更早按天归档）。
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

		/** 详情面板里「最近」与「已归档」的分界：24 小时。 */
		const RECENT_WINDOW_MS = 24 * 3600 * 1000;

		/** 退场动画时长（毫秒），到点才真正卸载。 */
		const EXIT_MS = 180;

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

		/** 按时间倒序列出小时桶（费用已换算成元）。 */
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
		 * 把小时桶分成两组：最近 24 小时（逐小时）与更早（按天归档）。
		 * 归档组把同一天的小时桶相加，并保留当天出现过的档位（多于一种记 mixed）。
		 * @param rows - hourRows(state) 的结果，已按时间倒序。
		 * @param now - 当前时刻，用于切 24 小时窗口。
		 * @returns {recent, archived} 两组，各自已带组内小计。
		 */
		function groupHours(rows, now) {
			const cutoff = hourKey(new Date(now.getTime() - RECENT_WINDOW_MS));
			const recent = [];
			const byDay = new Map();
			for (const row of rows) {
				if (row.hour >= cutoff) {
					recent.push(row);
					continue;
				}
				const day = row.hour.slice(0, 10);
				let bucket = byDay.get(day);
				if (bucket === undefined) {
					bucket = { day: day, hours: 0, cost: 0, hitTokens: 0, missTokens: 0, outTokens: 0, tiers: [] };
					byDay.set(day, bucket);
				}
				bucket.hours += 1;
				bucket.cost += row.cost;
				bucket.hitTokens += row.hitTokens;
				bucket.missTokens += row.missTokens;
				bucket.outTokens += row.outTokens;
				if (!bucket.tiers.includes(row.tier)) bucket.tiers.push(row.tier);
			}
			const archived = [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
			for (const bucket of archived) {
				bucket.tier = bucket.tiers.length > 1 ? "mixed" : bucket.tiers[0];
				delete bucket.tiers;
			}
			return {
				recent: recent,
				archived: archived,
				recentCost: recent.reduce((sum, row) => sum + row.cost, 0),
				archivedCost: archived.reduce((sum, row) => sum + row.cost, 0)
			};
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

		/** 由 YYYY-MM-DD 得到 "MM-DD"（归档行的日期标签）。 */
		function dayLabel(day) {
			return day.slice(5, 10);
		}

		// ------------------------------------------------------------------
		// 自绘弹窗的样式
		//
		// keyframes、:hover、滚动条这些内联样式表达不了，所以注入一份 <style>；
		// 颜色全部走 DSH 的 --dsw-* 设计 token，跟随主题。入场与退场各一套关键帧，
		// 退场由组件保持挂载直到动画结束（EXIT_MS）再卸载。
		// ------------------------------------------------------------------

		/** 注入样式元素的 id，重复挂载时用它判断是否已存在。 */
		const STYLE_ID = "dsh-session-cost-style";

		/** 弹窗样式表。 */
		const STYLE_TEXT = `
.sc-mask {
	position: fixed;
	inset: 0;
	z-index: 1000;
	display: flex;
	align-items: center;
	justify-content: center;
	padding: max(24px, var(--dsh-frame-top-clearance, 24px)) 24px;
	/* 遮罩只作为定位层和"点外部关闭"的命中区，不压暗、不模糊，也不做动画：
	   它本身全透明，动画没有可看的效果；而祖先的不透明度动画会让后代的 backdrop-filter 失效。 */
	background: transparent;
}
.sc-card {
	position: relative;
	display: flex;
	flex-direction: column;
	width: min(560px, 100%);
	max-height: 100%;
	border-radius: var(--dsw-radius-panel, 12px);
	/* 玻璃卡片：先把主题层色作为兜底，再用 color-mix 降到 78% 不透明。
	   模糊值取自 DSH 菜单的配方（--dsw-menu-backdrop-filter: blur(40px) saturate(150%)），
	   这里写死，避免注入样式表里取不到该变量。 */
	background: var(--dsw-alias-bg-layer-2);
	background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 78%, transparent);
	backdrop-filter: blur(40px) saturate(150%);
	box-shadow: var(--dsw-elevation-prominent);
	overflow: hidden;
}
/* 动画分给卡片的两段内容，而不是卡片本身：卡片一旦带 transform/opacity 动画就会成为
   backdrop root，模糊被截断——上一版看不到玻璃感正是这个原因。分段错开也让入场有层次。 */
.sc-head {
	animation: sc-head-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both;
}
.sc-body {
	animation: sc-body-in 220ms cubic-bezier(0.23, 1, 0.32, 1) 60ms both;
}
/* 退场让整块卡片淡出并轻微下沉：玻璃背景与阴影跟着一起走，不会在内容淡完后"啪"地整块消失。
   这层动画只在退场期间存在，此时模糊失效无所谓；入场不能用它，否则玻璃会跳变。 */
.sc-mask[data-phase="closing"] .sc-card {
	animation: sc-out ${EXIT_MS}ms cubic-bezier(0.23, 1, 0.32, 1) both;
}
@keyframes sc-head-in { from { opacity: 0 } to { opacity: 1 } }
@keyframes sc-body-in {
	from { opacity: 0; transform: translateY(10px) }
	to { opacity: 1; transform: none }
}
@keyframes sc-out {
	from { opacity: 1; transform: translateY(0) }
	to { opacity: 0; transform: translateY(6px) }
}
@media (prefers-reduced-motion: reduce) {
	.sc-head, .sc-body { animation-duration: 1ms }
}
.sc-head {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 8px;
	padding: 20px 16px 4px 24px;
}
.sc-title {
	margin: 0;
	font-size: 15px;
	line-height: 24px;
	font-weight: 500;
	color: var(--dsw-alias-label-primary);
}
.sc-close {
	position: relative;
	flex: none;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	border: none;
	border-radius: var(--dsw-radius-sm, 6px);
	background: transparent;
	cursor: pointer;
	font-size: 16px;
	line-height: 1;
	color: var(--dsw-alias-label-secondary);
}
/* 视觉尺寸保持 28px，点击区用伪元素扩到 40px（密集桌面 UI 的下限）。 */
.sc-close::after {
	content: '';
	position: absolute;
	inset: -6px;
}
@media (hover: hover) and (pointer: fine) {
	.sc-close:hover { background: var(--dsw-alias-interactive-bg-hover) }
}
.sc-body {
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 12px 24px 20px;
	font-size: 12px;
	font-variant-numeric: tabular-nums;
	color: var(--dsw-alias-label-primary);
}
.sc-sum {
	display: flex;
	flex-wrap: wrap;
	align-items: baseline;
	gap: 6px 14px;
	padding: 14px 16px;
	border-radius: 10px;
	background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, .08));
}
.sc-sum-main {
	font-size: 22px;
	line-height: 28px;
	font-weight: 600;
	color: var(--dsw-alias-label-primary);
}
.sc-sum-item { color: var(--dsw-alias-label-secondary) }
.sc-sec {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 8px;
	margin: 18px 0 6px;
	color: var(--dsw-alias-label-secondary);
}
.sc-sec-name { font-weight: 500 }
.sc-chart {
	display: flex;
	align-items: flex-end;
	gap: 2px;
	height: 54px;
	padding: 0 10px;
	margin: 2px 0 8px;
	border-bottom: 1px solid var(--dsw-alias-separator-primary);
}
.sc-bar {
	flex: 1 1 0;
	min-width: 2px;
	border-radius: 2px 2px 0 0;
	background: var(--sc-fill, currentColor);
	opacity: .75;
}
.sc-bar[data-empty="true"] { opacity: .16 }
.sc-axis {
	display: flex;
	justify-content: space-between;
	padding: 0 10px;
	margin-bottom: 6px;
	color: var(--dsw-alias-label-tertiary);
}
.sc-row {
	position: relative;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 7px 10px;
	border-radius: 8px;
}
.sc-row::before {
	content: '';
	position: absolute;
	left: 0;
	top: 50%;
	transform: translateY(-50%);
	height: 22px;
	width: var(--sc-pct, 0%);
	border-radius: 6px;
	background: var(--sc-fill, currentColor);
	opacity: .13;
	pointer-events: none;
}
@media (hover: hover) and (pointer: fine) {
	.sc-row:hover { background: var(--dsw-alias-interactive-bg-hover) }
}
.sc-dot {
	flex: none;
	position: relative;
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: var(--sc-fill, currentColor);
}
.sc-when { flex: none; position: relative; width: 88px; color: var(--dsw-alias-label-secondary) }
.sc-tokens {
	flex: 1;
	position: relative;
	min-width: 0;
	overflow: hidden;
	white-space: nowrap;
	text-overflow: ellipsis;
	color: var(--dsw-alias-label-tertiary);
}
.sc-cost { flex: none; position: relative; width: 78px; text-align: right }
.sc-total {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-top: 4px;
	padding: 6px 10px;
	border-top: 1px solid var(--dsw-alias-separator-primary);
	color: var(--dsw-alias-label-secondary);
}
.sc-total-cost { color: var(--dsw-alias-label-primary); font-weight: 500 }
.sc-hint {
	margin-top: 16px;
	padding: 0 10px;
	color: var(--dsw-alias-label-tertiary);
	line-height: 18px;
}
.sc-empty { padding: 18px 10px; color: var(--dsw-alias-label-tertiary) }
`;

		/** 注入弹窗样式；已存在时不动，避免重复。 */
		function ensureStyle() {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID) !== null) return;
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = STYLE_TEXT;
			document.head.appendChild(el);
		}

		/** 移除本插件注入的样式。 */
		function removeStyle() {
			if (typeof document === "undefined") return;
			const el = document.getElementById(STYLE_ID);
			if (el !== null) el.remove();
		}

		/** 测试钩子。 */
		const internals = {
			FLAT_PRICES, TIERED_PRICES, NEW_PRICING_AT, DEFAULT_MODEL, HOLIDAYS, PEAK_COLOR, OFF_COLOR,
			FLAT_COLOR, MIXED_COLOR, SAMPLE_INTERVAL_MS, STORAGE_PREFIX, PERSIST_THROTTLE_MS,
			LEDGER_VERSION, LEDGER_RETENTION_MS, RECENT_WINDOW_MS, EXIT_MS, STYLE_ID, STYLE_TEXT,
			isPeakBeijing, tierAt, priceFor, colorOf, usageSnapshot, emptyTiers, hourKey, pruneHours,
			hourRows, groupHours, chartRatios, initialLedger, accumulate, totalsOf, loadLedger, saveLedger,
			ledgerFor, sampleLedger, computeCost, billedTotal, formatTokens, hourLabel, dayLabel,
			LEDGERS
		};

		// ------------------------------------------------------------------
		// 组件 + 注册
		// ------------------------------------------------------------------

		/** 中文文案：底部条目 + 头部入口 + 详情面板。 */
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
			"recentTitle": "最近 24 小时",
			"archivedTitle": "已归档",
			"subtotal": "小计",
			"hoursUnit": "{n} 小时",
			"allDay": "全天",
			"total": "合计",
			"noData": "还没有可展示的用量记录。",
			"hint": "按小时聚合，保留最近 7 天；超过 24 小时的按天归档。金额为估算值（≈）。"
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
			"recentTitle": "Last 24 hours",
			"archivedTitle": "Archived",
			"subtotal": "Subtotal",
			"hoursUnit": "{n} h",
			"allDay": "full day",
			"total": "Total",
			"noData": "No usage recorded yet.",
			"hint": "Aggregated by hour, last 7 days kept; older than 24 hours is archived by day. Amounts are estimates (≈)."
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
			const tierColor = colorOf(tier);
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

		/** 一行明细：色点 + 时间 + token 摘要 + 费用，底色按占总量比例填充。 */
		function detailRow(t, options) {
			const color = colorOf(options.tier);
			const pct = options.share <= 0 ? 0 : Math.max(options.share * 100, 0.5);
			return (0, react_jsx_runtime.jsxs)("div", {
				className: "sc-row",
				style: { "--sc-pct": pct.toFixed(2) + "%", "--sc-fill": color },
				children: [
					(0, react_jsx_runtime.jsx)("span", { className: "sc-dot" }),
					(0, react_jsx_runtime.jsx)("span", { className: "sc-when", children: options.when }),
					(0, react_jsx_runtime.jsx)("span", {
						className: "sc-tokens",
						children: options.detail === undefined
							? t(options.tier)
							: t(options.tier) + " · " + options.detail
					}),
					(0, react_jsx_runtime.jsx)("span", {
						className: "sc-cost",
						children: "¥" + options.cost.toFixed(4)
					})
				]
			}, options.key);
		}

		/** token 摘要文本：命中 / 未命中 / 输出。 */
		function tokenSummary(t, row) {
			return t("hit", { amount: formatTokens(row.hitTokens) }).replace("¥", "")
				+ " · " + t("miss", { amount: formatTokens(row.missTokens) }).replace("¥", "")
				+ " · " + t("out", { amount: formatTokens(row.outTokens) }).replace("¥", "");
		}

		/** 柱状图的逐根占比（相对本组最大值）；全为 0 时返回全 0。 */
		function chartRatios(bars) {
			let max = 0;
			for (const bar of bars) if (bar.cost > max) max = bar.cost;
			return bars.map((bar) => (max <= 0 ? 0 : bar.cost / max));
		}

		/**
		 * 最近 24 小时的柱状图：固定 24 根柱，没花钱的小时留一根极淡的底线，
		 * 使时间轴连续、一眼看出哪几个钟头在花钱。柱高按该小时费用占本组最大值的
		 * 比例，颜色沿用档位色。图表是给人读的数据，不做逐根生长的动画。
		 */
		function detailChart(t, bars) {
			const ratios = chartRatios(bars);
			const first = bars[0];
			const last = bars[bars.length - 1];
			return (0, react_jsx_runtime.jsxs)("div", {
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: "sc-chart",
						role: "img",
						"aria-label": t("recentTitle"),
						children: bars.map((bar, i) => {
							const empty = bar.cost <= 0;
							return (0, react_jsx_runtime.jsx)("div", {
								className: "sc-bar",
								"data-empty": empty ? "true" : "false",
								style: {
									height: (empty ? 1.5 : Math.max(ratios[i] * 100, 3)).toFixed(2) + "%",
									"--sc-fill": colorOf(bar.tier)
								},
								title: hourLabel(bar.hour) + "  ¥" + bar.cost.toFixed(4)
							}, bar.hour);
						})
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: "sc-axis",
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: hourLabel(first.hour) }),
							(0, react_jsx_runtime.jsx)("span", { children: hourLabel(last.hour) })
						]
					})
				]
			});
		}

		/** 一个分区：标题 + 可选柱状图 + 若干行 + 小计。 */
		function detailSection(t, title, rows, cost, total, chart) {
			return (0, react_jsx_runtime.jsxs)("div", {
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: "sc-sec",
						children: [
							(0, react_jsx_runtime.jsx)("span", { className: "sc-sec-name", children: title }),
							(0, react_jsx_runtime.jsx)("span", { children: t("subtotal") + " ≈¥" + cost.toFixed(4) })
						]
					}),
					chart === undefined ? null : chart,
					rows,
					(0, react_jsx_runtime.jsxs)("div", {
						className: "sc-total",
						children: [
							(0, react_jsx_runtime.jsx)("span", { children: title }),
							(0, react_jsx_runtime.jsx)("span", {
								className: "sc-total-cost",
								children: (total <= 0 ? "" : ((cost / total) * 100).toFixed(1) + "%  ") + "¥" + cost.toFixed(4)
							})
						]
					})
				]
			});
		}

		/**
		 * 会话标题旁（conversation.session.header.actions）的「费用」入口。
		 * 点开是自绘弹窗（毛玻璃遮罩 + 卡片），顶部是合计，下面两段：
		 * 「最近 24 小时」逐小时列出，「已归档」把更早的小时桶按天合计。
		 * 入场与退场都有动画：关闭时先把 phase 置为 closing 播退场，EXIT_MS 后才卸载。
		 * 座位是 scope: 'session'，因此拿到 sessionId 取对应账本。
		 */
		function CostDetail(props) {
			const t = props.t;
			const sessionId = props.sessionId;
			const useProjection = props.useProjection;
			const phaseState = react.useState("closed");
			const phase = phaseState[0];
			const setPhase = phaseState[1];
			const bump = react.useState(0)[1];
			// actions 座位不保证带 standard kit；有投影钩子就顺带采样，没有就只读已有账本。
			const usage = typeof useProjection === "function" ? useProjection("tokenUsage") : undefined;

			const close = () => setPhase((current) => (current === "open" ? "closing" : current));

			// 退场动画播完再卸载。
			react.useEffect(() => {
				if (phase !== "closing") return undefined;
				const timer = setTimeout(() => setPhase("closed"), EXIT_MS);
				return () => clearTimeout(timer);
			}, [phase]);

			// Escape 关闭。
			react.useEffect(() => {
				if (phase === "closed") return undefined;
				const onKey = (event) => { if (event.key === "Escape") close(); };
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, [phase]);

			// 打开期间每分钟刷新，跟随后台采样。
			react.useEffect(() => {
				if (phase === "closed") return undefined;
				if (typeof useProjection === "function") sampleLedger(sessionId, usage, new Date(), true);
				const timer = setInterval(() => bump((n) => n + 1), SAMPLE_INTERVAL_MS);
				return () => clearInterval(timer);
			}, [phase, sessionId]);

			const state = LEDGERS.get(ledgerKey(sessionId));
			const parts = state === undefined ? undefined : totalsOf(state);
			const total = parts === undefined ? 0 : parts.total;
			const grouped = state === undefined
				? { recent: [], archived: [], recentCost: 0, archivedCost: 0 }
				: groupHours(hourRows(state), new Date());

			// 柱状图固定 24 根：从当前小时逐小时回推，缺的小时由 detailChart 画成极淡底线。
			const bars = [];
			if (state !== undefined) {
				const nowDate = new Date();
				for (let back = 23; back >= 0; back -= 1) {
					const key = hourKey(new Date(nowDate.getTime() - back * 3600e3));
					const bucket = state.hours[key];
					bars.push({
						hour: key,
						cost: bucket === undefined ? 0 : bucket.cost / 1e6,
						tier: bucket === undefined ? "flat" : bucket.tier
					});
				}
			}

			const rows = [];
			for (const row of grouped.recent) {
				rows.push(detailRow(t, {
					key: row.hour,
					when: hourLabel(row.hour),
					tier: row.tier,
					detail: tokenSummary(t, row),
					cost: row.cost,
					share: total <= 0 ? 0 : row.cost / total
				}));
			}
			const dayRows = [];
			for (const day of grouped.archived) {
				dayRows.push(detailRow(t, {
					key: day.day,
					when: dayLabel(day.day),
					tier: day.tier,
					detail: (day.hours >= 24 ? t("allDay") : t("hoursUnit", { n: day.hours })) + " · " + tokenSummary(t, day),
					cost: day.cost,
					share: total <= 0 ? 0 : day.cost / total
				}));
			}

			const sections = [];
			if (grouped.recent.length > 0) {
				sections.push(detailSection(
					t, t("recentTitle"), rows, grouped.recentCost, total,
					bars.length > 0 ? detailChart(t, bars) : undefined
				));
			}
			if (grouped.archived.length > 0) {
				sections.push(detailSection(t, t("archivedTitle"), dayRows, grouped.archivedCost, total));
			}

			const body = (0, react_jsx_runtime.jsxs)("div", {
				className: "sc-body",
				children: [
					(0, react_jsx_runtime.jsx)("div", {
						className: "sc-sum",
						children: parts === undefined || total <= 0
							? (0, react_jsx_runtime.jsx)("span", { className: "sc-sum-item", children: t("noData") })
							: [
								(0, react_jsx_runtime.jsx)("span", { className: "sc-sum-main", children: "≈¥" + total.toFixed(4) }, "main"),
								(0, react_jsx_runtime.jsx)("span", { className: "sc-sum-item", children: t("hit", { amount: parts.hit.toFixed(4) }) }, "hit"),
								(0, react_jsx_runtime.jsx)("span", { className: "sc-sum-item", children: t("miss", { amount: parts.miss.toFixed(4) }) }, "miss"),
								(0, react_jsx_runtime.jsx)("span", { className: "sc-sum-item", children: t("out", { amount: parts.out.toFixed(4) }) }, "out")
							]
					}),
					sections.length > 0 ? sections : (0, react_jsx_runtime.jsx)("div", { className: "sc-empty", children: t("noData") }),
					(0, react_jsx_runtime.jsx)("div", { className: "sc-hint", children: t("hint") })
				]
			});

			const overlay = (0, react_jsx_runtime.jsx)("div", {
				className: "sc-mask",
				"data-phase": phase,
				role: "presentation",
				onClick: close,
				children: (0, react_jsx_runtime.jsxs)("div", {
					className: "sc-card",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": t("detailTitle"),
					onClick: (event) => event.stopPropagation(),
					children: [
						(0, react_jsx_runtime.jsxs)("div", {
							className: "sc-head",
							children: [
								(0, react_jsx_runtime.jsx)("h2", { className: "sc-title", children: t("detailTitle") }),
								(0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "sc-close",
									"aria-label": t("close"),
									onClick: close,
									children: "✕"
								})
							]
						}),
						body
					]
				})
			});

			return (0, react_jsx_runtime.jsxs)(react.Fragment, {
				children: [
					(0, react_jsx_runtime.jsx)(Button, {
						variant: "ghost",
						size: "sm",
						onClick: () => setPhase("open"),
						children: t("detail")
					}),
					phase === "closed"
						? null
						: (createPortal === undefined || typeof document === "undefined"
							? overlay
							: createPortal(overlay, document.body))
				]
			});
		}

		/** Required services: the slot registry and the locale seat. */
		const inject = ["slots", "locale"];

		/** Client plugin body: register dictionaries, the dock entry, and the header detail entry. */
		function apply(ctx) {
			ctx.effect(() => {
				ensureStyle();
				return removeStyle;
			}, "session-cost: styles");
			ctx.effect(() => ctx.locale.register("session-cost", { zh, en }), "session-cost: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "session-cost",
				order: 100,
				locale: "session-cost"
			}, CostChip));
			// 头部入口需要 Button；拿不到时不注册，底部条目照常工作。
			if (Button !== undefined) {
				ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
					name: "conversation.session.header.actions",
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
