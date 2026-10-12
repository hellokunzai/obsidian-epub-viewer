/**
 * [INPUT]: 依赖浏览器 DOMParser/XMLSerializer、XMLHttpRequest 与 atob/decodeURIComponent 等 Web API
 * [OUTPUT]: 对外提供 EPUB 内容安全过滤（script/iframe/object/embed 移除、on* 事件与 javascript: URL 清除）
 *          和 blob:/data: 样式表内联（绕过 Obsidian CSP 限制），供 spine content/serialize hook 调用
 * [POS]: epub 模块的安全与样式内联基础设施，保障 EPUB iframe 内不可执行脚本且样式表可正常渲染
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

// ---- 常量 ----

/** 匹配 HTML 中所有 <link rel="stylesheet"> 标签的正则 */
const STYLESHEET_LINK_RE =
	/<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi;

/** 需要从 EPUB 内容中移除的标签名集合 */
const UNSAFE_TAGS = new Set(["script", "iframe", "object", "embed"]);

/** 可能包含 URL 的属性名集合，用于检测 javascript: 等不安全 URL */
const URL_ATTRS = new Set(["src", "href", "xlink:href", "formaction", "action"]);

// ---- 内部辅助函数 ----

/**
 * 从 <link> 标签字符串中提取 href 属性值。
 * 返回提取到的 href 字符串，若未找到则返回 null。
 */
function extractHref(tag: string): string | null {
	const match = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
	return match?.[1] ?? null;
}

/**
 * 判断 href 是否属于 Obsidian CSP 会拦截的协议（blob: 或 data:）。
 * 这些协议的样式表链接必须内联为 <style> 才能在 iframe 中正常渲染。
 */
function isBlockedStylesheetHref(href: string): boolean {
	return href.startsWith("blob:") || href.startsWith("data:");
}

/**
 * 对 CSS 文本进行安全转义，防止其内容被浏览器误解析为结束标签。
 * 将 </style 替换为 <\/style，确保内联样式不会意外闭合 <style> 标签。
 */
function escapeStyleText(css: string): string {
	return css.replace(/<\/style/gi, "<\\/style");
}

/**
 * 判断 URL 值是否包含不安全协议。
 * 检测 javascript:、vbscript: 以及可能执行脚本的数据 URI。
 */
function isUnsafeUrl(value: string): boolean {
	const normalized = value.trim().replace(/[\u0000-\u001f\s]+/g, "").toLowerCase();
	return (
		normalized.startsWith("javascript:") ||
		normalized.startsWith("vbscript:") ||
		normalized.startsWith("data:text/html") ||
		normalized.startsWith("data:application/xhtml+xml") ||
		normalized.startsWith("data:image/svg+xml")
	);
}

/**
 * 从 Element 对象获取小写本地标签名，兼容 XML 命名空间前缀（如 epub:script）。
 */
function elementLocalName(el: Element): string {
	return (el.localName || el.tagName.split(":").pop() || "").toLowerCase();
}

/**
 * 将属性名标准化为小写形式。
 */
function attrLocalName(attrName: string): string {
	return attrName.toLowerCase();
}

/**
 * 移除单个元素上的所有不安全属性：
 * - on* 事件处理器（onclick、onerror 等）
 * - srcdoc 属性（iframe 内嵌 HTML）
 * - 包含不安全协议的 URL 属性（src、href、formaction、action）
 * - 包含 javascript:/expression() 的 style 属性
 */
function stripUnsafeAttributes(el: Element): void {
	const attributes = Array.from(el.attributes);
	for (const attr of attributes) {
		const name = attrLocalName(attr.name);
		const localName = name.includes(":") ? (name.split(":").pop() ?? name) : name;

		if (localName.startsWith("on") || localName === "srcdoc") {
			el.removeAttribute(attr.name);
			continue;
		}

		if ((URL_ATTRS.has(name) || URL_ATTRS.has(localName)) && isUnsafeUrl(attr.value)) {
			el.removeAttribute(attr.name);
			continue;
		}

		if (localName === "style" && /(javascript:|vbscript:|expression\s*\()/i.test(attr.value)) {
			el.removeAttribute(attr.name);
		}
	}
}

/**
 * 检查 DOMParser 解析结果是否包含 <parsererror> 元素，
 * 用于判断 XHTML 解析是否成功。
 */
function hasParserError(doc: Document): boolean {
	return doc.getElementsByTagName("parsererror").length > 0;
}

/**
 * 使用 DOM API 对 HTML 进行安全过滤：先通过 stripScriptsFromHtml 做正则预处理，
 * 再用 DOMParser 解析后调用 stripScriptsFromDocument 做精确 DOM 级过滤。
 * 优先尝试 XHTML 解析（保留 EPUB 命名空间），失败时回退到 HTML 解析。
 */
function sanitizeHtmlWithDom(html: string): string {
	const stripped = stripScriptsFromHtml(html);

	try {
		const xhtmlDoc = new DOMParser().parseFromString(stripped, "application/xhtml+xml");
		if (!hasParserError(xhtmlDoc)) {
			stripScriptsFromDocument(xhtmlDoc);
			return new XMLSerializer().serializeToString(xhtmlDoc);
		}
	} catch {
		/* 回退到 HTML 解析 */
	}

	try {
		const htmlDoc = new DOMParser().parseFromString(stripped, "text/html");
		stripScriptsFromDocument(htmlDoc);
		return htmlDoc.documentElement.outerHTML;
	} catch {
		return stripped;
	}
}

// ---- 导出函数 ----

/**
 * 从已解析的 Document 对象中移除所有可执行内容。
 * 遍历所有元素，删除 script/iframe/object/embed 标签，
 * 并清除其余元素上的 on* 事件属性和不安全 URL。
 *
 * 适用场景：epub.js spine content hook，在 iframe 加载前清理 DOM。
 *
 * @param doc - 已解析的 XML/HTML Document 对象，会被原地修改
 */
export function stripScriptsFromDocument(doc: Document): void {
	const allElements = Array.from(doc.getElementsByTagName("*"));
	for (let index = allElements.length - 1; index >= 0; index -= 1) {
		const el = allElements[index];
		if (UNSAFE_TAGS.has(elementLocalName(el))) {
			el.parentNode?.removeChild(el);
			continue;
		}
		stripUnsafeAttributes(el);
	}
}

/**
 * 使用正则表达式从 HTML 字符串中移除可执行内容。
 * 处理以下威胁：
 * - <script>、<iframe>、<object>、<embed> 标签（含自闭合和命名空间前缀）
 * - on* 事件属性（onclick、onerror 等）
 * - srcdoc 属性
 * - 包含 javascript:/vbscript: 的 URL 属性
 * - 包含 javascript:/expression() 的 style 属性
 *
 * @param html - 原始 HTML 字符串
 * @returns 经过安全过滤的 HTML 字符串
 */
export function stripScriptsFromHtml(html: string): string {
	let result = html;

	// 移除成对的 script/iframe/object 标签（含内容）
	result = result.replace(
		/<[\w.-]*:?(script|iframe|object)\b[\s\S]*?<\/[\w.-]*:?\1>/gi,
		"",
	);

	// 移除自闭合的 script/iframe/object/embed 标签
	result = result.replace(
		/<[\w.-]*:?(script|iframe|object|embed)\b[^>]*\/?>/gi,
		"",
	);

	// 移除 on* 事件属性
	result = result.replace(
		/\s[\w:.-]*on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
		"",
	);

	// 移除 srcdoc 属性
	result = result.replace(
		/\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
		"",
	);

	// 移除包含不安全协议的 URL 属性
	result = result.replace(
		/\s([\w:.-]*(?:src|href)|formaction|action)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
		(match: string, attrName: string, rawValue: string) => {
			const unquoted = rawValue.replace(/^["']|["']$/g, "");
			return isUnsafeUrl(unquoted) ? "" : match;
		},
	);

	// 移除包含不安全内容的 style 属性
	result = result.replace(
		/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
		(match: string, rawValue: string) => {
			const unquoted = rawValue.replace(/^["']|["']$/g, "");
			return /(javascript:|vbscript:|expression\s*\()/i.test(unquoted) ? "" : match;
		},
	);

	return result;
}

/**
 * 异步版本的 EPUB section HTML 安全过滤。
 * 先执行脚本移除和 DOM 级安全过滤，再将 blob:/data: 样式表内联为 <style> 标签。
 *
 * 适用场景：spine serialize hook，在 section.output 写入 iframe srcdoc 前调用。
 *
 * @param html - 原始 section HTML 字符串
 * @returns 经过安全过滤和样式内联的 HTML 字符串
 */
export async function sanitizeSectionHtml(html: string): Promise<string> {
	return inlineStylesheetLinksInHtml(sanitizeHtmlWithDom(html));
}

/**
 * 同步版本的 EPUB section HTML 安全过滤。
 * 仅执行脚本移除和 DOM 级安全过滤，不处理样式表内联（避免异步操作阻塞渲染）。
 *
 * 适用场景：spine serialize hook 的同步路径，或不需要样式内联的场景。
 *
 * @param html - 原始 section HTML 字符串
 * @returns 经过安全过滤的 HTML 字符串
 */
export function sanitizeSectionHtmlSync(html: string): string {
	return sanitizeHtmlWithDom(html);
}

/**
 * 将 HTML 字符串中所有 blob: 和 data: 协议的 <link rel="stylesheet"> 替换为内联 <style> 标签。
 * Obsidian 的 CSP 策略会拦截 iframe 中的 blob: 和 data: 资源请求，
 * 因此必须在写入 iframe srcdoc 之前将样式表内联。
 *
 * @param html - 经过脚本过滤的 HTML 字符串
 * @returns 样式表已内联的 HTML 字符串
 */
export async function inlineStylesheetLinksInHtml(html: string): Promise<string> {
	const tags = html.match(STYLESHEET_LINK_RE);
	if (!tags?.length) {
		return html;
	}

	let result = html;
	for (const tag of tags) {
		const href = extractHref(tag);
		if (!href || !isBlockedStylesheetHref(href)) {
			continue;
		}

		try {
			const css = await readStylesheetHref(href);
			if (!css) {
				result = result.replace(tag, "");
				continue;
			}
			const styleTag = `<style data-book-note-inlined="1">${escapeStyleText(css)}</style>`;
			result = result.replace(tag, styleTag);
		} catch (error) {
			console.warn("epub-viewer: stylesheet inline failed in serialize hook", href, error);
			result = result.replace(tag, "");
		}
	}

	return result;
}

/**
 * 在阅读引擎 content/load hook 中内联被 CSP 拦截的样式表。
 * 直接操作 iframe 内的 Document DOM，将 <link> 替换为 <style>。
 *
 * @param contents - epub.js contents 对象或 foliate load 事件包装的 document
 */
export async function inlineBlockedStylesheets(contents: any): Promise<void> {
	if (!contents?.document) {
		return;
	}

	const doc: Document = contents.document;
	stripScriptsFromDocument(doc);

	const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
	for (const node of links) {
		const link = node as HTMLLinkElement;
		const href = link.getAttribute("href");
		if (!href || !isBlockedStylesheetHref(href)) {
			continue;
		}

		try {
			const css = await readStylesheetHref(href);
			if (!css) {
				link.remove();
				continue;
			}
			const style = doc.createElement("style");
			style.setAttribute("data-book-note-inlined", "1");
			style.textContent = css;
			link.parentNode?.insertBefore(style, link);
			link.remove();
		} catch (error) {
			console.warn("epub-viewer: stylesheet inline failed in content hook", href, error);
			link.remove();
		}
	}
}

/**
 * 读取样式表的 CSS 文本内容。
 * 支持 data: URI（自动解码 base64 或 URL 编码）和常规 URL（通过 XHR 请求）。
 *
 * @param href - 样式表的 URL，可以是 data: URI、blob: URL 或常规 HTTP(S) URL
 * @returns 解码后的 CSS 文本；若 href 无效则返回空字符串
 */
export function readStylesheetHref(href: string): Promise<string> {
	if (href.startsWith("data:")) {
		const commaIndex = href.indexOf(",");
		if (commaIndex < 0) {
			return Promise.resolve("");
		}
		const meta = href.slice(0, commaIndex);
		const payload = href.slice(commaIndex + 1);
		const css = meta.includes("base64") ? atob(payload) : decodeURIComponent(payload);
		return Promise.resolve(css);
	}

	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("GET", href);
		xhr.responseType = "text";
		xhr.onload = () => resolve(xhr.responseText ?? "");
		xhr.onerror = () => reject(new Error(`Stylesheet read failed: ${href}`));
		xhr.send();
	});
}

export { isBlockedStylesheetHref };
