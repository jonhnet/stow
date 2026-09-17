import catalogue from './kittens/catalogue.json';
import kitten0 from './kittens/01-cardboard-inspector.webp';
import kitten1 from './kittens/02-laundry-supervisor.webp';
import kitten2 from './kittens/03-sunbeam-auditor.webp';
import kitten3 from './kittens/04-library-assistant.webp';
import kitten4 from './kittens/05-garden-committee.webp';
import kitten5 from './kittens/06-blanket-researcher.webp';
import kitten6 from './kittens/07-paperwork-inspector.webp';
import kitten7 from './kittens/08-nap-coordinator.webp';
import kitten8 from './kittens/09-window-observer.webp';
import kitten9 from './kittens/10-basket-ambassador.webp';
import kitten10 from './kittens/11-toy-quality-control.webp';
import kitten11 from './kittens/12-sofa-expedition.webp';

const urls = [kitten0, kitten1, kitten2, kitten3, kitten4, kitten5, kitten6, kitten7, kitten8, kitten9, kitten10, kitten11];
export const kittenAssets = new Map(catalogue.map((kitten, i) => [kitten.hash, { ...kitten, url: urls[i] }]));
