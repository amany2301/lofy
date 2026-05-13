/* lofy — palette definitions */
export const BUILTIN_PALETTES = [
  { id:'neon-night',   name:'Neon Night',   mode:'spectrum',  colors:['#7F77DD','#D4537E','#534AB7','#00f0ff'] },
  { id:'fire-set',     name:'Fire Set',     mode:'flash',     colors:['#EF9F27','#D85A30','#E24B4A','#FCDE5A'] },
  { id:'ocean-rave',   name:'Ocean Rave',   mode:'particles', colors:['#1D9E75','#5DCAA5','#378ADD','#00f0ff'] },
  { id:'sunrise',      name:'Sunrise',      mode:'spectrum',  colors:['#FCDE5A','#EF9F27','#1D9E75','#D4537E'] },
  { id:'cotton-candy', name:'Cotton Candy', mode:'flash',     colors:['#F0997B','#D4537E','#7F77DD','#FCDE5A'] },
  { id:'monochrome',   name:'Monochrome',   mode:'particles', colors:['#FFFFFF','#888780','#2C2C2A','#444441'] },
  { id:'laser-show',   name:'Laser Show',   mode:'flash',     colors:['#5DCAA5','#D4537E','#FFFFFF','#7a3cff'] },
  { id:'deep-space',   name:'Deep Space',   mode:'particles', colors:['#042C53','#534AB7','#0F6E56','#00f0ff'] },
  // Brand default — lofy's identity palette
  { id:'lofy-default', name:'Lofy Default', mode:'spectrum',  colors:['#ff2d87','#7a3cff','#00f0ff','#d8ff3a'] },
];

export function paletteById(id){
  return BUILTIN_PALETTES.find(p => p.id === id) || BUILTIN_PALETTES[BUILTIN_PALETTES.length-1];
}
