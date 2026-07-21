const ERROR_MESSAGE = "Сообщение содержит ненормативную лексику. Переформулируйте, пожалуйста.";

const CONFUSABLES = new Map(
  Object.entries({
    a: "а",
    e: "е",
    o: "о",
    p: "р",
    c: "с",
    x: "х",
    y: "у",
    k: "к",
    m: "м",
    t: "т",
    b: "в",
    h: "н",
    0: "о",
    3: "з",
    4: "ч",
    6: "б",
    "@": "а",
    "$": "с"
  })
);

const WORD_PATTERNS = [
  /(^|[^а-я])бл(?:я|яд|ять)([^а-я]|$)/u,
  /(^|[^а-я])(?:сука|сучара|мудак|мудила|гандон|пидар|пидор|шлюха)([^а-я]|$)/u,
  /(^|[^а-я])(?:хуй|хуе|хуя|хуи|хуйн|нахуй|охуе)([а-я]*)([^а-я]|$)/u,
  /(^|[^а-я])(?:еба|ебат|ебан|ебуч|ебл|ебн|заеб|наеб|проеб|выеб|уеб|разъеб|подъеб)([а-я]*)([^а-я]|$)/u,
  /(^|[^а-я])(?:пизд|пезд|пздц|залуп|манда)([а-я]*)([^а-я]|$)/u
];

const COMPACT_PATTERNS = [
  /бляд|блять/u,
  /(?:хуй|хуе|хуя|хуи|хуйн|нахуй|охуе)/u,
  /(?:еба|ебат|ебан|ебуч|ебл|ебн|заеб|наеб|проеб|выеб|уеб|разъеб|подъеб)/u,
  /(?:пизд|пезд|пздц|залуп|манда|мудак|мудил|гандон|пидар|пидор|шлюх)/u
];

function containsProfanity(value) {
  const normalized = normalizeForModeration(value);
  if (!normalized) return false;

  if (WORD_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  const compact = removeSafeWords(normalized.replace(/[^а-я0-9]+/gu, ""));
  return COMPACT_PATTERNS.some((pattern) => pattern.test(compact));
}

function assertCleanText(value) {
  if (!containsProfanity(value)) return;
  throw Object.assign(new Error(ERROR_MESSAGE), { statusCode: 400, code: "PROFANITY_DETECTED" });
}

function normalizeForModeration(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .split("")
    .map((char) => CONFUSABLES.get(char) || char)
    .join("")
    .replace(/[\u0300-\u036f]/g, "");
}

function removeSafeWords(value) {
  return value.replace(/(?:за)?страху(?:й|и|ю|ем|ете|ют|йте)[а-я]*/gu, "");
}

module.exports = {
  ERROR_MESSAGE,
  containsProfanity,
  assertCleanText
};
