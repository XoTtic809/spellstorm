/**
 * Word pool system for SpellStorm.
 * Words are categorized by difficulty and served randomly without repeats per match.
 */

const WORD_POOL = {
  easy: [
    'cat', 'dog', 'run', 'sun', 'fun', 'map', 'cap', 'top', 'box', 'fix',
    'cup', 'bat', 'hop', 'pin', 'dig', 'log', 'mud', 'nap', 'peg', 'rib',
    'sap', 'tin', 'vat', 'wax', 'yak', 'zap', 'bay', 'cob', 'dew', 'elk',
    'fawn', 'gust', 'helm', 'inch', 'jolt', 'kelp', 'lark', 'mist', 'newt',
    'oval', 'pact', 'quay', 'ruse', 'sage', 'tusk', 'ulna', 'vale', 'wasp',
    'yawn', 'zinc', 'arch', 'bolt', 'clam', 'dusk', 'echo', 'fern', 'gale',
    'husk', 'iris', 'jade', 'knit', 'loft', 'monk', 'nook', 'omen', 'pear',
    'quip', 'rind', 'silk', 'tomb', 'undo', 'veil', 'wren', 'yarn', 'zeal',
    'bask', 'clef', 'daub', 'earl', 'fawn', 'glib', 'hasp', 'ibis', 'jest',
    'keen', 'lieu', 'mast', 'narc', 'oast', 'pave', 'quell', 'raze', 'slew',
  ],
  medium: [
    'garden', 'planet', 'bridge', 'castle', 'desert', 'engine', 'forest',
    'garden', 'harbor', 'island', 'jungle', 'kettle', 'lantern', 'marble',
    'nectar', 'orange', 'parrot', 'quartz', 'rabbit', 'salmon', 'tangle',
    'umbra', 'violet', 'walrus', 'xylem', 'yellow', 'zipper', 'anchor',
    'blizzard', 'captain', 'dolphin', 'eclipse', 'flutter', 'gallop',
    'harvest', 'inspire', 'journal', 'knuckle', 'labyrinth', 'marvel',
    'nostril', 'obscure', 'pendant', 'quarrel', 'restore', 'stumble',
    'thunder', 'unravel', 'venture', 'warrior', 'extreme', 'yielding',
    'bracket', 'crystal', 'dazzle', 'emerald', 'freckle', 'goblin',
    'hydrant', 'illusion', 'jackal', 'kestrel', 'locket', 'muffin',
    'narrate', 'orbital', 'pebble', 'quarry', 'rattle', 'scalpel',
    'trickle', 'upward', 'valley', 'warden', 'yeoman', 'zealous',
    'abstract', 'balance', 'cabinet', 'decimal', 'element', 'fiction',
    'genetic', 'horizon', 'integer', 'javelin', 'keynote', 'literal',
    'monitor', 'nucleus', 'opinion', 'perfect', 'quantum', 'radiant',
    'sapphire', 'texture', 'uniform', 'vibrant', 'weather', 'xenon',
  ],
  hard: [
    'aberration', 'belligerent', 'cacophony', 'desiccate', 'ephemeral',
    'facetious', 'garrulous', 'hierarchy', 'inimitable', 'juxtapose',
    'kaleidoscope', 'loquacious', 'melancholy', 'nonchalant', 'oblivious',
    'paraphernalia', 'querulous', 'recalcitrant', 'serendipity', 'truculent',
    'ubiquitous', 'vicissitude', 'whimsical', 'xenophobia', 'yodeling',
    'zealotry', 'ambiguous', 'bureaucracy', 'clandestine', 'dilapidated',
    'exacerbate', 'fallacious', 'gregarious', 'hypocritical', 'inadvertent',
    'juggernaut', 'kinesthetic', 'laborious', 'magnanimous', 'nefarious',
    'ostentatious', 'pandemonium', 'quintessential', 'reminiscent', 'sycophant',
    'tumultuous', 'unprecedented', 'venomous', 'warranted', 'xylophone',
    'acquiesce', 'benevolent', 'capricious', 'discombobulate', 'egalitarian',
    'flamboyant', 'grandiloquent', 'hallucinate', 'incomprehensible', 'jeopardize',
    'knowledgeable', 'luminescent', 'magnificent', 'nonchalance', 'omniscient',
    'perpendicular', 'questionable', 'revolutionary', 'susceptible', 'tenacious',
    'unequivocal', 'vehemently', 'worthwhile', 'exhilarating', 'perspicacious',
    'circumlocution', 'obfuscation', 'ineffable', 'surreptitious', 'loquacity',
    'perspicacity', 'inscrutable', 'impecunious', 'equivocation', 'pusillanimous',
  ],
};

// Flat pool with difficulty weights:  easy=20%, medium=50%, hard=30%
const WEIGHTS = { easy: 0.20, medium: 0.50, hard: 0.30 };

/**
 * Build a randomized word list for a match (no repeats).
 * @param {number} count - Number of words needed
 * @returns {Array<{ word: string, difficulty: string }>}
 */
function buildMatchWordList(count) {
  const easyCount  = Math.round(count * WEIGHTS.easy);
  const medCount   = Math.round(count * WEIGHTS.medium);
  const hardCount  = count - easyCount - medCount;

  const pick = (pool, n) => shuffle([...pool]).slice(0, Math.min(n, pool.length));

  const words = [
    ...pick(WORD_POOL.easy, easyCount).map(w => ({ word: w, difficulty: 'easy' })),
    ...pick(WORD_POOL.medium, medCount).map(w => ({ word: w, difficulty: 'medium' })),
    ...pick(WORD_POOL.hard, hardCount).map(w => ({ word: w, difficulty: 'hard' })),
  ];

  return shuffle(words);
}

/**
 * Fisher-Yates shuffle (in-place, returns array).
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Validate an answer against the expected word (case-insensitive, trimmed).
 * @param {string} answer
 * @param {string} correctWord
 * @returns {boolean}
 */
function isCorrect(answer, correctWord) {
  return answer.trim().toLowerCase() === correctWord.toLowerCase();
}

module.exports = { buildMatchWordList, isCorrect, WORD_POOL };
