import type { NoteColor } from './core/types';

export const COLORS: { value: NoteColor; label: string; hex: string }[] = [
  { value: 'default', label: 'Default', hex: '#ffffff' }, { value: 'coral', label: 'Coral', hex: '#faafa8' },
  { value: 'peach', label: 'Peach', hex: '#f39f76' }, { value: 'sand', label: 'Sand', hex: '#fff8b8' },
  { value: 'mint', label: 'Mint', hex: '#e2f6d3' }, { value: 'sage', label: 'Sage', hex: '#b4ddd3' },
  { value: 'fog', label: 'Fog', hex: '#d4e4ed' }, { value: 'storm', label: 'Storm', hex: '#aeccdc' },
  { value: 'dusk', label: 'Dusk', hex: '#d3bfdb' }, { value: 'blossom', label: 'Blossom', hex: '#f6e2dd' },
  { value: 'clay', label: 'Clay', hex: '#e9e3d4' }, { value: 'gray', label: 'Gray', hex: '#e8eaed' },
];

export const noteColor = (color: NoteColor) => COLORS.find(c => c.value === color)!.hex;
