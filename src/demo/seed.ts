import type { Vault } from '../core/vault';
import type { NoteColor } from '../core/types';
import kittens from './kittens/catalogue.json';

// A small, entirely original corpus. No remote generator and no personal notes.
const corpus = [
  'The committee has reviewed the biscuits and found them structurally delicious.',
  'The committee has postponed the meeting until the moon returns our ladder.',
  'The meeting will begin when the kettle has finished its dramatic monologue.',
  'The kettle has reviewed the minutes and requested a smaller font for the screaming.',
  'Our research suggests that the sofa contains a previously undocumented continent.',
  'Our research suggests that the biscuits should be stored in alphabetical order.',
  'The sofa contains a tiny embassy with excellent diplomatic immunity.',
  'A tiny embassy has requested three cushions and a ceremonial teaspoon.',
  'The ceremonial teaspoon will chair the meeting in a purely advisory capacity.',
  'The moon has requested a refund because the clouds arrived without instructions.',
  'The clouds arrived early and ate the emergency biscuits before the committee could object.',
  'The emergency biscuits have been replaced by a strongly worded drawing of a biscuit.',
  'Please direct all complaints to the fern, which has considerable experience standing quietly.',
  'The fern has finished its report on the mysterious absence of second breakfast.',
  'Second breakfast will resume once the department has located its trousers.',
  'The department has located a promising sunbeam and suspended all other operations.',
];
const words = corpus.flatMap(sentence => sentence.split(' '));
const nextWords = new Map<string, string[]>();
for (let i = 0; i < words.length - 2; i++) {
  const key = `${words[i]} ${words[i + 1]}`;
  const next = nextWords.get(key) ?? []; next.push(words[i + 2]); nextWords.set(key, next);
}

/** Reproducible fixtures in tests; production supplies fresh browser randomness. */
export function demoRandom(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export function seedDemo(vault: Vault, seed: number, now = Date.now()) {
  const random = demoRandom(seed);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
  const shuffled = <T,>(values: readonly T[]) => {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [result[i], result[j]] = [result[j], result[i]]; }
    return result;
  };
  const paragraph = () => {
    const text = pick(corpus).split(' ').slice(0, 2);
    for (let i = 0; i < 100; i++) {
      const next = nextWords.get(text.slice(-2).join(' '));
      if (!next) break;
      text.push(pick(next));
      if (text.length > 48 && /[.!?]$/.test(text.at(-1)!)) break;
    }
    return text.join(' ').replace(/[,.!?;:]?$/, '.');
  };
  const colours: NoteColor[] = ['default', 'coral', 'peach', 'sand', 'mint', 'sage', 'fog', 'storm', 'dusk', 'blossom', 'clay', 'gray'];
  const labels = ['Committees', 'Highly important', 'Questionable recipes', 'Field research', 'Kittens'];
  labels.forEach((name, i) => vault.setLabelColor(name, colours[i + 3]));
  type Task = string | { text: string; children: string[]; checked?: boolean };
  interface Spec { title: string; body?: string; tasks?: Task[]; archived?: boolean; trashed?: boolean; pinned?: boolean; label?: string; kitten?: typeof kittens[number] }
  const ambassador = pick(['Professor Crumbs', 'Captain Pudding', 'Dr. Noodle', 'Admiral Biscuit', 'Deputy Waffles']);
  const appliance = pick(['kettle', 'vacuum cleaner', 'rice cooker', 'desk fan', 'waffle iron']);
  const specs: Spec[] = [
    { title: 'Minutes of the emergency kitten committee', pinned: true, label: 'Committees', body: `**Chair:** ${ambassador}\n\n1. Establish whether the red dot is a public utility.\n2. Reclassify the keyboard as heated seating.\n3. Approve a second, smaller committee to sit in the box.\n\n> The motion passed by three purrs and one conspicuous yawn.\n\nNext meeting: whenever someone opens a cupboard.` },
    { title: 'Packing for a diplomatic mission to the refrigerator', pinned: true, label: 'Highly important', tasks: [
      { text: 'Travel documents', children: ['Passport (laminated slice of cheese)', 'Visa for the vegetable drawer', 'A reference from the butter'], checked: true },
      { text: 'Formal attire', children: ['One ceremonial tea towel', 'Emergency socks for the olives'] },
      { text: 'Gifts for our hosts', children: ['A small, tasteful magnet', 'A convincing explanation for the expired yogurt'] },
      'Practice saying “I come in peas”', 'Do not recognize the freezer’s territorial claims',
    ] },
    { title: 'Maintenance: a mildly haunted toaster', label: 'Field research', body: 'The ghost is friendly. The warranty is ambiguous.', tasks: [
      { text: 'Routine inspection', children: ['Listen for supernatural bagel requests', 'Check whether the crumbs spell anything actionable'] },
      { text: 'Ghost relations', children: ['Offer a polite greeting', 'Explain that sourdough is not a summoning circle'], checked: true },
      'File the weekly crumb report', 'Reschedule the exorcist as a breakfast consultant',
    ] },
    { title: 'Field guide to the uncharted sofa', label: 'Field research', body: `# Expedition ${100 + Math.floor(random() * 900)}\n\nA long note for anyone who believes the answer is **further down**.\n\n## Essential equipment\n\n- A torch\n- A biscuit compass\n- A healthy respect for the space behind the cushions\n\n| Landmark | Discovery | Confidence |\n| --- | --- | --- |\n| North cushion | Three coins | Quite high |\n| Central ravine | The other remote | Unreasonably high |\n| Blanket plateau | A kitten | Purring |\n\n\`\`\`text\nif expedition.finds("crumb"):\n    declare_national_park()\n\`\`\`\n\n${Array.from({ length: 20 }, (_, i) => `## Day ${i + 1}: ${pick(['A promising crevice', 'Negotiations with the dust', 'Unscheduled biscuits', 'Maps of uncertain authority'])}\n\n${paragraph()}\n\n${paragraph()}`).join('\n\n')}\n\n---\n\n**Final recommendation:** move the sofa six inches to the left.` },
    { title: 'Ideas that could become a checklist', label: 'Highly important', body: 'Negotiate a four-day week for the houseplants\nTeach the doorbell a less judgmental tone\nFind out who promoted the printer\nWrite an apology to the missing sock\n\nThe note menu can turn these lines into checklist items.' },
    { title: 'Recipe: soup with plausible deniability', label: 'Questionable recipes', body: `## Ingredients\n\n- 2 cups of optimism\n- 1 very cooperative potato\n- A pinch of ${pick(['regret', 'diplomatic immunity', 'unearned confidence'])}\n\n## Method\n\n1. Place everything in a pot.\n2. Explain the situation calmly.\n3. Simmer until the committee stops asking questions.\n\n**Serves:** four, or one extremely determined person.\n\n~~Add glitter~~ Do not add glitter.` },
  ];
  const selectedKittens = shuffled(kittens).slice(0, 4);
  selectedKittens.forEach((kitten, i) => specs.push({ title: `${kitten.name}: ${pick(['Probation passed', 'Employee of the minute', 'Very small, very qualified', 'No references required'])}`, kitten, label: 'Kittens', pinned: i === 0,
    body: `Meet ${pick(['Beans', 'Mochi', 'Pickle', 'Crumpet', 'Pebble', 'Miso', 'Sprout', 'Turnip'])}.\n\n**Qualifications:** ${pick(['Can occupy a box of any size.', 'Nine lives, zero deadlines.', 'Will attend meetings if they contain a sunbeam.', 'Exceptional attention to moving objects.'])}\n\n${pick(['Currently auditing the laundry department.', 'Please do not disturb the strategic nap.', 'Has already eaten the onboarding paperwork.', 'Compensation requested: one cardboard box.'])}` }));
  const titles = [
    `Performance review: the ${appliance}`, 'Emergency biscuit inventory', 'A stern letter to gravity', 'Proposal for a quieter Tuesday',
    'Garden gnome succession planning', 'Minutes from a meeting nobody attended', 'A small list of enormous ambitions',
    'The lost sock witness protection program', 'Business plan: artisanal puddles', 'Questions for the moon',
    'Instructions found inside a suspicious teapot', 'Neighborhood cloud inspection', 'Things the fern has declined to explain',
    'An unusually formal shopping list', 'Draft apology to the kitchen floor',
  ];
  shuffled(titles).forEach((title, i) => specs.push({ title, label: pick(labels.slice(0, 4)), body: i % 3 === 0 ? 'Please initial each item with a small drawing of a duck.' : paragraph(),
    ...(i % 3 === 0 ? { tasks: [
      { text: pick(['Preparation', 'Official business', 'First breakfast']), children: shuffled(['Locate the ceremonial clipboard', 'Count the biscuits twice', 'Check the weather inside the cupboard', 'Consult a reasonably confident pigeon']).slice(0, 3) },
      'Proceed with an air of quiet competence', 'Take a well-earned snack break',
    ] } : {}),
  }));
  ['Treaty of the microwave', 'The great cupboard census', 'Resolved: a mysterious spoon', 'Last year’s ambitious nap schedule'].forEach(title => specs.push({ title, body: paragraph(), archived: true, label: 'Committees' }));
  ['Rejected proposal: jet-powered slippers', 'Shopping list for an imaginary dragon', 'A meeting to schedule the next meeting'].forEach(title => specs.push({ title, body: paragraph(), trashed: true }));
  const colourOffset = Math.floor(random() * colours.length);
  for (const [i, spec] of specs.entries()) {
    const id = vault.createNote(spec.tasks ? 'checklist' : 'text', { title: spec.title, body: spec.body });
    vault.setNoteMeta(id, { color: colours[(i + colourOffset) % colours.length], pinned: spec.pinned ?? false, archived: spec.archived ?? false, trashed: spec.trashed ?? false });
    // Sample age changes presentation only; it does not simulate a bloated edit log.
    const created = now - (i + 1) * 3_600_000 - Math.floor(random() * 600_000);
    const source = vault.notes.get(id)!;
    source.set('createdAt', created);
    source.set('placement', { pinned: spec.pinned ?? false, sortOrderDate: created });
    if (spec.label) vault.setNoteLabel(id, spec.label, true);
    for (const task of spec.tasks ?? []) {
      const item = vault.addItem(id, typeof task === 'string' ? task : task.text);
      if (typeof task !== 'string') {
        task.children.forEach(text => vault.addItem(id, text, item));
        if (task.checked) vault.toggleItem(item);
      } else if (random() < .3) vault.toggleItem(item);
    }
    if (spec.kitten) vault.addAttachment({ id: crypto.randomUUID(), noteId: id, hash: spec.kitten.hash, name: `${spec.kitten.name}.webp`, type: 'image/webp', size: spec.kitten.size, order: 0 });
    source.set('updatedAt', created + 60_000);
  }
  vault.finishEdit();
  vault.undoManager.clear();
  return selectedKittens;
}
