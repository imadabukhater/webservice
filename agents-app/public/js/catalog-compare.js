// Pure helpers for grouping eSIM catalog packages per company and package tier
// to highlight the cheapest supplier for each package.

export const SUPPLIER = { ql: 'QuickLine', ly: 'ليان', tc: 'telecom', ay: 'أيلول' };
export const supplierLabel = (code) => SUPPLIER[code] || code || 'غير محدد';

const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const toLatinDigits = (s) => String(s || '').replace(/[٠-٩۰-۹]/g, (d) => ARABIC_DIGITS[d] || d);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const escapeRe = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const hasValidPrice = (v) => v !== null && v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0;

export function extractGb(pkg) {
  if (Number(pkg?.dataGb) > 0) return round2(Number(pkg.dataGb));
  const text = toLatinDigits(pkg?.name);
  const tb = text.match(/(\d+(?:\.\d+)?)\s*(?:تيرا(?:\s*بايت)?|tb(?![a-z]))/i);
  if (tb && Number(tb[1]) > 0) return round2(Number(tb[1]) * 1000);
  // Includes common supplier typo "جبجا" for "جيجا".
  const gb = text.match(/(\d+(?:\.\d+)?)\s*(?:جيجا(?:\s*بايت)?|جبجا|غيغا(?:\s*بايت)?|قيقا|جيكا|ج\.ب|gb(?![a-z]))/i);
  if (gb && Number(gb[1]) > 0) return round2(Number(gb[1]));
  // Match shorthand like "100G" while never confusing network names "3G" / "4G" / "5G".
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*g(?![a-z0-9])/gi)) {
    const val = Number(m[1]);
    if (val >= 10) return round2(val);
  }
  return null;
}

export function extractDays(pkg) {
  if (Number(pkg?.days) > 0) return Math.round(Number(pkg.days));
  const text = toLatinDigits(pkg?.name);
  const days = text.match(/(\d+)\s*(?:يوم|يوماً|يوما|ايام|أيام|days?|d(?![a-z]))/i);
  if (days && Number(days[1]) > 0) return Number(days[1]);
  const months = text.match(/(\d+)\s*(?:شهر|شهور|أشهر|اشهر|شهراً|شهرا|months?|m(?![a-z]))/i);
  if (months && Number(months[1]) > 0) return Number(months[1]) * 30;
  const weeks = text.match(/(\d+)\s*(?:أسبوع|اسبوع|أسابيع|اسابيع|weeks?)/i);
  if (weeks && Number(weeks[1]) > 0) return Number(weeks[1]) * 7;
  if (/(?:شهرين|شهران)/.test(text)) return 60;
  if (/ثلاثة?\s*(?:أشهر|اشهر)/.test(text)) return 90;
  if (/ستة?\s*(?:أشهر|اشهر)/.test(text)) return 180;
  if (/(?:سنة|سنوي)/.test(text)) return 360;
  if (/(?:أسبوع|اسبوع)/.test(text)) return 7;
  return 30;
}

export function formatDays(days) {
  const d = Number(days) || 30;
  if (d === 7) return 'أسبوع (7 أيام)';
  if (d === 30) return 'شهري (30 يوم)';
  if (d === 60) return 'شهران (60 يوم)';
  if (d === 90) return '3 أشهر (90 يوم)';
  if (d === 180) return '6 أشهر (180 يوم)';
  if (d === 360 || d === 365) return `سنوي (${d} يوم)`;
  return `${d} يوم`;
}

function cleanBundleName(name, companyName) {
  let s = toLatinDigits(name);
  if (companyName) s = s.replace(new RegExp(escapeRe(companyName), 'gi'), ' ');
  s = s
    .replace(/\b(?:quickline|layan|aylol|telecom|e-?sim)\b/gi, ' ')
    .replace(/(?:كويك\s*لاين|ليان|أيلول|ايلول|تليكوم|إي\s*سيم|اي\s*سيم)/g, ' ')
    .replace(/\d+\s*(?:يوم|يوماً|يوما|ايام|أيام|شهر|شهور|أشهر|اشهر|شهراً|شهرا|days?|months?)/gi, ' ')
    .replace(/(?:شهرين|شهران|شهري|سنوي)/g, ' ')
    .replace(/[-–—·|/()_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s || String(name || 'رزمة').trim();
}

export function packageTier(pkg) {
  const gb = extractGb(pkg);
  const days = extractDays(pkg);
  const durationLabel = formatDays(days);
  if (gb !== null) {
    return { key: `gb:${gb}:${days}`, label: `${gb} جيجا`, durationLabel, gb, days, sortKind: 0, sortOrder: gb };
  }
  if (/(?:مفتوح|لامحدود|لا\s*محدود|غير\s*محدود|unlimited)/i.test(String(pkg?.name || ''))) {
    return { key: `unlimited:${days}`, label: 'إنترنت مفتوح', durationLabel, gb: null, days, sortKind: 1, sortOrder: 0 };
  }
  const cleaned = cleanBundleName(pkg?.name, pkg?.companyName);
  const norm = cleaned.toLowerCase().replace(/\s+/g, ' ').trim() || String(pkg?.name || '').toLowerCase().trim();
  return { key: `other:${norm}:${days}`, label: cleaned, durationLabel, gb: null, days, sortKind: 2, sortOrder: 0 };
}

function pickTopSupplier(tiers) {
  const multiSup = tiers.filter((t) => t.supplierCount >= 2 && t.cheapestSuppliers.length);
  const pool = multiSup.length ? multiSup : tiers.filter((t) => t.isComparable && t.cheapestSuppliers.length);
  if (!pool.length) return null;
  const counts = new Map();
  for (const t of pool) {
    for (const sup of t.cheapestSuppliers) counts.set(sup, (counts.get(sup) || 0) + 1);
  }
  let best = 0;
  for (const n of counts.values()) if (n > best) best = n;
  const labels = [...counts.entries()].filter(([, n]) => n === best).map(([k]) => k);
  return { label: labels.join('، '), wins: best };
}

export function compareCatalog(packages) {
  const byCompany = new Map();
  for (const p of packages || []) {
    const companyName = p.companyName || 'بدون شركة';
    if (!byCompany.has(companyName)) byCompany.set(companyName, new Map());
    const tierMap = byCompany.get(companyName);
    const meta = packageTier(p);
    if (!tierMap.has(meta.key)) tierMap.set(meta.key, { ...meta, raw: [] });
    tierMap.get(meta.key).raw.push(p);
  }

  const companies = [];
  const allTiers = [];

  for (const [companyName, tierMap] of byCompany) {
    const tiers = [];
    for (const entry of tierMap.values()) {
      const sorted = [...entry.raw].sort((a, b) => {
        if (!!a.available !== !!b.available) return a.available ? -1 : 1;
        const ap = hasValidPrice(a.supplierPrice);
        const bp = hasValidPrice(b.supplierPrice);
        if (ap !== bp) return ap ? -1 : 1;
        if (ap && bp && Number(a.supplierPrice) !== Number(b.supplierPrice)) return Number(a.supplierPrice) - Number(b.supplierPrice);
        if (!!a.inShop !== !!b.inShop) return a.inShop ? -1 : 1;
        const al = supplierLabel(a.supplier);
        const bl = supplierLabel(b.supplier);
        if (al !== bl) return al.localeCompare(bl, 'ar');
        return (a.id || 0) - (b.id || 0);
      });

      const availPriced = sorted.filter((o) => o.available && hasValidPrice(o.supplierPrice));
      const allPriced = sorted.filter((o) => hasValidPrice(o.supplierPrice));
      const hasAvailablePriced = availPriced.length > 0;
      const pool = hasAvailablePriced ? availPriced : allPriced;

      const minPrice = pool.length ? Math.min(...pool.map((o) => Number(o.supplierPrice))) : null;
      const maxPrice = pool.length ? Math.max(...pool.map((o) => Number(o.supplierPrice))) : null;
      const savings = minPrice !== null && maxPrice !== null && maxPrice > minPrice ? round2(maxPrice - minPrice) : 0;

      const offers = sorted.map((o) => {
        const priced = hasValidPrice(o.supplierPrice);
        const eligible = hasAvailablePriced ? (o.available && priced) : priced;
        const isCheapest = eligible && minPrice !== null && Number(o.supplierPrice) === minPrice;
        const diff = priced && minPrice !== null && Number(o.supplierPrice) > minPrice
          ? round2(Number(o.supplierPrice) - minPrice)
          : (priced ? 0 : null);
        return { ...o, supplierLabel: supplierLabel(o.supplier), isCheapest, diff };
      });

      const cheapestSuppliers = [...new Set(offers.filter((o) => o.isCheapest).map((o) => o.supplierLabel))];
      const supplierCount = new Set(offers.map((o) => o.supplier || o.supplierLabel)).size;
      const overpriced = hasAvailablePriced && minPrice !== null
        ? offers.filter((o) => o.inShop && hasValidPrice(o.supplierPrice) && Number(o.supplierPrice) > minPrice)
        : [];
      const overpricedDiff = overpriced.length
        ? round2(Math.max(...overpriced.map((o) => Number(o.supplierPrice) - minPrice)))
        : 0;

      const tier = {
        key: entry.key,
        label: entry.label,
        durationLabel: entry.durationLabel,
        gb: entry.gb,
        days: entry.days,
        sortKind: entry.sortKind,
        sortOrder: entry.sortOrder,
        offers,
        minPrice,
        maxPrice,
        savings,
        cheapestSuppliers,
        supplierCount,
        isComparable: offers.length > 1,
        hasAvailablePriced,
        hasOverpricedInShop: overpriced.length > 0,
        overpricedDiff,
        inShopCount: offers.filter((o) => o.inShop).length,
      };
      tiers.push(tier);
      allTiers.push(tier);
    }

    tiers.sort((a, b) => (a.sortKind - b.sortKind)
      || (a.sortOrder - b.sortOrder)
      || (a.days - b.days)
      || a.label.localeCompare(b.label, 'ar'));

    companies.push({
      companyName,
      tiers,
      tierCount: tiers.length,
      comparableCount: tiers.filter((t) => t.isComparable).length,
      overpricedCount: tiers.filter((t) => t.hasOverpricedInShop).length,
      topSupplier: pickTopSupplier(tiers),
    });
  }

  return {
    companies,
    summary: {
      totalTiers: allTiers.length,
      comparableTiers: allTiers.filter((t) => t.isComparable).length,
      overpricedTiers: allTiers.filter((t) => t.hasOverpricedInShop).length,
      maxSavings: allTiers.reduce((m, t) => Math.max(m, t.savings), 0),
      topSupplier: pickTopSupplier(allTiers),
    },
  };
}
