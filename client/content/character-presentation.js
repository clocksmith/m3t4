export const BODY_VARIANTS = {
  sama: "capacity_mystic",
  darrius: "policy_undertaker",
  demis: "quiet_solver",
  mark: "sunlit_operator",
  jensen: "silicon_sovereign",
  elon: "orbital_showman",
};

export const BODY_PORTRAIT_SHEETS = {
  sama: "assets/chars/sama/monastic_infra/portraits/sheet.png",
  darrius: "assets/chars/darrius/legal_department_midnight/portraits/sheet.png?v=appearance-20261023b",
  demis: "assets/chars/demis/chalk_and_static/portraits/sheet.png",
  mark: "assets/chars/mark/wellness_berserker/portraits/sheet.png",
  jensen: "assets/chars/jensen/silicon_sovereign/portraits/sheet.png?v=appearance-20261023c",
  elon: "assets/chars/elon/orbital_showman/portraits/sheet.png?v=appearance-20261023c",
};

// These generated busts have more top padding than the original 96px art.
// A measured source crop aligns crown, chin and shoulders; body cell 3 stays
// untouched. The same crop is consumed by Canvas and CSS portrait users.
const BUST_CROPS = {
  jensen: [0.10, 0.10, 0.80, 0.80],
  elon: [0.15, 0.14, 0.70, 0.70],
};
export function portraitCellCrop(body, cell=0) {
  return cell<3 && BUST_CROPS[body] ? BUST_CROPS[body] : [0,0,1,1];
}
export function portraitSourceRect(body, cell, width, height) {
  const [x,y,w,h]=portraitCellCrop(body,cell),cw=width/2,ch=height/2;
  return [(cell%2+x)*cw,(Math.floor(cell/2)+y)*ch,w*cw,h*ch];
}
export function portraitBackgroundStyle(body, cell=3) {
  const url=BODY_PORTRAIT_SHEETS[body];if(!url)return '';
  const [x,y,w,h]=portraitCellCrop(body,cell);
  return `background-image:url('${url}');background-size:${200/w}% ${200/h}%;background-position:${(cell%2+x)/(2-w)*100}% ${(Math.floor(cell/2)+y)/(2-h)*100}%`;
}
