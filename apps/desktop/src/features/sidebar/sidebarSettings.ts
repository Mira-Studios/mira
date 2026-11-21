export const SIDEBAR_SECTIONS = ['bookmarks', 'profiles', 'recently-closed'] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type SidebarSide = 'left' | 'right';
export type SidebarMode = 'collapsed' | 'expanded' | 'hover';
export const SIDEBAR_SECTION_LABELS: Record<SidebarSection, string> = {
  bookmarks: 'Bookmarks',
  profiles: 'Profiles',
  'recently-closed': 'Recently closed',
};

export function normalizeSidebarSections(value: unknown): SidebarSection[] {
  if (!Array.isArray(value)) return [...SIDEBAR_SECTIONS];
  return [
    ...new Set(
      value.filter(
        (section): section is SidebarSection =>
          typeof section === 'string' && SIDEBAR_SECTIONS.includes(section as SidebarSection),
      ),
    ),
  ];
}

export function normalizeSidebarSectionOrder(value: unknown): SidebarSection[] {
  const ordered = normalizeSidebarSections(value);
  return [...ordered, ...SIDEBAR_SECTIONS.filter((section) => !ordered.includes(section))];
}

export function moveSidebarSection(
  sections: SidebarSection[],
  section: SidebarSection,
  offset: -1 | 1,
): SidebarSection[] {
  const index = sections.indexOf(section);
  const destination = index + offset;
  if (index < 0 || destination < 0 || destination >= sections.length) return sections;
  const next = [...sections];
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
