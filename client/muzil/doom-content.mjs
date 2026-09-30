// Tiny, local heuristics: language is a stop-word vote; nonsense is a joke score
// for the text, never a judgment of a language or its speakers.
const WORDS = {
  en: 'the this your is are has my just with why you a and of for',
  es: 'el la los una tu tus es mi porque para pero que con',
  fr: 'le les une votre est mon pourquoi dans mais avec des vous',
  pt: 'o os uma seu sua meu voce isso nao porque para mas com',
};
const fold = text => text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
export function classifyPost(text) {
  const tokens = fold(text).match(/[a-z]+/g) || [];
  const scores = Object.entries(WORDS).map(([language, words]) => ({ language, score: tokens.filter(t => words.split(' ').includes(t)).length })).sort((a,b)=>b.score-a.score);
  const language = scores[0].score >= 2 && scores[0].score > scores[1].score ? scores[0].language : 'und';
  const absurd = new Set('quantum sentient cosmic toaster pigeon algorithm soup moon spreadsheet cucumber holographic chaotic quantico consciente cosmico torradeira pombo algoritmo sopa lua planilha pepino cuantico tostadora paloma luna hoja quantique conscient cosmique grille pain pigeon algorithme soupe lune tableur concombre'.split(' '));
  const silly = new Set(tokens.filter(t => absurd.has(t))).size;
  const bait = (fold(text).match(/secret|secreto|segredo|shocking|urgent|urgente|incroyable|increible|unbelievable|nao acredito|no vas a creer|vous ne croirez|wait for|espera|attendez/g) || []).length;
  const caps = (text.match(/\b[A-ZÀ-Ü]{4,}\b/g) || []).length;
  const repetition = tokens.length - new Set(tokens).size;
  const nonsense = Math.min(99, Math.round(silly * 17 + bait * 14 + Math.min(12, caps * 4) + Math.min(8, repetition)));
  return { language, nonsense, label: nonsense > 70 ? 'full brain rot' : nonsense > 35 ? 'deeply unserious' : 'mostly harmless' };
}
const BANKS = [
  { language:'en', subjects:['my toaster','the moon','your spreadsheet','a quantum pigeon','the algorithm','this cucumber'], claims:['has a secret podcast','is running for mayor','just became sentient','has monetized soup','is your new life coach','has opinions about your aura'], endings:['You are not ready for this.','Wait for the shocking reveal.','The comments are a group project.','This is what peak productivity looks like.','Part 1 of 900.','UNBELIEVABLE. It gets worse.'] },
  { language:'es', subjects:['mi tostadora','la luna','tu hoja de cálculo','una paloma cuántica','el algoritmo','este pepino'], claims:['tiene un podcast secreto','es la nueva alcaldesa','tiene conciencia propia','vende sopa cósmica','es tu nuevo entrenador','lee tu aura con una cuchara'], endings:['No vas a creer el final.','Es urgente pero no sirve para nada.','Los comentarios son otra dimensión.','Tu productividad es una ilusión.','Parte 1 de 900.','INCREÍBLE. Espera para ver más.'] },
  { language:'fr', subjects:['mon grille-pain','la lune','votre tableur','un pigeon quantique','le grand algorithme','ce concombre'], claims:['a un podcast secret','est le nouveau maire','est devenu conscient','vend de la soupe cosmique','est votre coach de vie','lit votre aura avec une cuillère'], endings:['Vous ne croirez pas la fin.','Le secret est dans les commentaires.','Une idée incroyable mais inutile.','Votre productivité est une illusion.','Partie 1 sur 900.','URGENT. Attendez la suite.'] },
  { language:'pt', subjects:['minha torradeira','a lua','sua planilha','um pombo quântico','o algoritmo','este pepino'], claims:['tem um podcast secreto','é o novo prefeito','ficou consciente','vende sopa cósmica','é seu novo treinador','lê sua aura com uma colher'], endings:['Você não vai acreditar no final.','O segredo está nos comentários.','Isso é urgente mas não serve para nada.','Sua produtividade é uma ilusão.','Parte 1 de 900.','INCRÍVEL. Não acredito nisso.'] },
];
function random(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0),16777619);
  return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ h >>> 15, 1 | h); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function doomPost(seed, index) {
  const rand = random(`doom/v1:${seed}:${index}`), pick = list => list[Math.floor(rand()*list.length)];
  const bank = BANKS[Math.floor(rand()*BANKS.length)];
  const text = `${pick(bank.subjects)} ${pick(bank.claims)}. ${pick(bank.endings)}`;
  const analysis = classifyPost(text);
  return { index, text, ...analysis, sourceLanguage:bank.language, handle:pick(['soup.exe','mildly.cosmic','pan.in.progress','aura.department','pigeon.capital','just.one.more']), likes:Math.floor(120+rand()*98000), hue:Math.floor(rand()*360), symbol:pick(['◎','✳','∞','◈','↯']), topic:pick(['FOR YOU, APPARENTLY','EXTREMELY ONLINE','THOUGHTS & VIBRATIONS','THE ALGORITHM PROVIDES']) };
}
