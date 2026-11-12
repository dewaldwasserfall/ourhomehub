/**
 * Shopping categories and a keyword-based guesser.
 *
 * The order of CATEGORIES is the order sections appear on a shopping list,
 * roughly following a walk through a Dutch supermarket (Albert Heijn / Jumbo).
 * Keywords include common Dutch names so either language works.
 */

export const CATEGORIES = [
  "Produce",
  "Bakery",
  "Meat & fish",
  "Dairy & eggs",
  "Pantry",
  "Frozen",
  "Drinks",
  "Snacks",
  "Household",
  "Personal care",
  "Baby & pets",
  "Other",
] as const;

export type Category = (typeof CATEGORIES)[number];

// Step 1: keyword lists per category (lowercase, matched on word starts).
const KEYWORDS: Record<Exclude<Category, "Other">, string[]> = {
  Produce: [
    "apple", "banana", "lemon", "lime", "orange", "grape", "berr", "strawberr", "blueberr", "avocado",
    "tomato", "potato", "onion", "garlic", "ginger", "carrot", "lettuce", "salad", "spinach", "cucumber",
    "pepper", "paprika", "broccoli", "mushroom", "zucchini", "courgette", "herb", "basil", "parsley",
    "coriander", "fruit", "veg", "appel", "banaan", "citroen", "aardappel", "ui", "knoflook", "wortel",
    "sla", "komkommer", "champignon", "groente", "fruit",
  ],
  Bakery: ["bread", "brood", "baguette", "croissant", "bagel", "roll", "bun", "wrap", "tortilla", "pita", "beschuit", "cake"],
  "Meat & fish": [
    "chicken", "beef", "pork", "mince", "steak", "bacon", "sausage", "ham", "salami", "salmon", "tuna",
    "fish", "shrimp", "prawn", "kip", "gehakt", "vlees", "worst", "spek", "vis", "zalm", "biltong", "boerewors",
  ],
  "Dairy & eggs": [
    "milk", "cheese", "butter", "yoghurt", "yogurt", "cream", "egg", "kwark", "melk", "kaas", "boter",
    "room", "ei", "eieren", "skyr",
  ],
  Pantry: [
    "pasta", "rice", "flour", "sugar", "salt", "oil", "olive", "vinegar", "sauce", "ketchup", "mayo",
    "mustard", "spice", "stock", "bouillon", "bean", "lentil", "chickpea", "cereal", "oats", "muesli",
    "granola", "honey", "jam", "peanut butter", "pindakaas", "hagelslag", "coffee", "koffie", "tea", "thee",
    "can", "tin", "noodle", "rijst", "meel", "suiker", "zout", "olie", "saus",
  ],
  Frozen: ["frozen", "ice cream", "ijs", "diepvries", "pizza", "fries", "patat", "frites"],
  Drinks: ["water", "juice", "sap", "soda", "cola", "beer", "bier", "wine", "wijn", "lemonade", "limonade", "sparkling", "spa"],
  Snacks: ["chips", "crisps", "chocolate", "chocola", "cookie", "koek", "biscuit", "nuts", "noten", "popcorn", "candy", "snoep", "drop"],
  Household: [
    "toilet paper", "wc-papier", "wc papier", "paper towel", "keukenrol", "dish", "afwas", "detergent",
    "wasmiddel", "laundry", "softener", "bleach", "cleaner", "sponge", "spons", "bin bag", "vuilniszak",
    "foil", "folie", "cling", "battery", "batterij", "light bulb", "lamp", "candle", "kaars", "tissue",
    "napkin", "servet",
  ],
  "Personal care": [
    "shampoo", "conditioner", "soap", "zeep", "toothpaste", "tandpasta", "toothbrush", "deodorant", "deo",
    "razor", "scheer", "lotion", "sunscreen", "zonnebrand", "plaster", "pleister", "paracetamol", "ibuprofen",
    "vitamin", "floss", "cotton", "wattenstaafje", "tampon", "pad", "maandverband",
  ],
  "Baby & pets": ["nappy", "nappies", "diaper", "luier", "wipes", "billendoek", "formula", "baby", "cat", "kat", "dog", "hond", "litter", "kattenbak"],
};

// Step 2: longest keywords first, so "peanut butter" beats "butter".
const RULES: Array<{ keyword: string; category: Category }> = Object.entries(KEYWORDS)
  .flatMap(([category, words]) => words.map((keyword) => ({ keyword, category: category as Category })))
  .sort((a, b) => b.keyword.length - a.keyword.length);

/**
 * Guess the category for a shopping item from its name.
 * Matches keywords at the start of any word ("oat milk" -> Dairy via "milk").
 */
export function guessCategory(name: string): Category {
  const text = ` ${name.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim()}`;
  for (const { keyword, category } of RULES) {
    // Short keywords ("ui", "ei", "spa") must match a whole word to avoid false hits.
    const pattern = keyword.length <= 3 ? ` ${keyword}(?:$| )` : ` ${keyword}`;
    if (new RegExp(pattern).test(text)) return category;
  }
  return "Other";
}

/** Sort key for a category name (unknown categories go just before Other). */
export function categoryRank(category: string): number {
  const index = CATEGORIES.indexOf(category as Category);
  return index === -1 ? CATEGORIES.length - 1.5 : index;
}
