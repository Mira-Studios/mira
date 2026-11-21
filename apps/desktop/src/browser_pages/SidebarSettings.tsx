import { ArrowDown, ArrowUp } from 'lucide-react';
import { electron } from '../electronBridge';
import { saveBrowserSettings } from '../features/settings/browserSettings';
import {
  SIDEBAR_SECTIONS,
  SIDEBAR_SECTION_LABELS,
  moveSidebarSection,
} from '../features/sidebar/sidebarSettings';
import { useSidebarSettings } from '../features/sidebar/useSidebarSettings';

export default function SidebarSettings() {
  const settings = useSidebarSettings();
  const available = SIDEBAR_SECTIONS.filter(
    (section) => !electron?.isPrivate || section !== 'profiles',
  );
  const ordered = settings.sidebarSectionOrder.filter((section) => available.includes(section));
  return (
    <section className="settings-group">
      <div className="settings-card-header">
        <h3 className="settings-card-title">Sidebar</h3>
      </div>
      <div className="settings-card">
        <label className="settings-setting-row" htmlFor="sidebar-enabled">
          <span className="settings-setting-label">Show sidebar</span>
          <input
            id="sidebar-enabled"
            type="checkbox"
            className="settings-toggle settings-setting-control"
            checked={settings.sidebarEnabled}
            onChange={(event) =>
              saveBrowserSettings({ sidebarEnabled: event.currentTarget.checked })
            }
          />
        </label>
        <label className="settings-setting-row" htmlFor="sidebar-side">
          <span className="settings-setting-label">Sidebar side</span>
          <select
            id="sidebar-side"
            className="theme-input settings-select-input settings-select-limit settings-setting-control"
            value={settings.sidebarSide}
            onChange={(event) =>
              saveBrowserSettings({
                sidebarSide: event.currentTarget.value === 'right' ? 'right' : 'left',
              })
            }
          >
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
        <label className="settings-setting-row" htmlFor="sidebar-mode">
          <span className="settings-setting-label">Sidebar behavior</span>
          <select
            id="sidebar-mode"
            className="theme-input settings-select-input settings-select-limit settings-setting-control"
            value={settings.sidebarMode}
            onChange={(event) =>
              saveBrowserSettings({
                sidebarMode:
                  event.currentTarget.value === 'hover'
                    ? 'hover'
                    : event.currentTarget.value === 'expanded'
                      ? 'expanded'
                      : 'collapsed',
              })
            }
          >
            <option value="collapsed">Always collapsed</option>
            <option value="expanded">Always open</option>
            <option value="hover">Expand on hover</option>
          </select>
        </label>
        <label className="settings-setting-row" htmlFor="sidebar-tooltips">
          <span className="settings-setting-label">Show tooltips when collapsed</span>
          <input
            id="sidebar-tooltips"
            type="checkbox"
            className="settings-toggle settings-setting-control"
            checked={settings.sidebarShowTooltips}
            onChange={(event) =>
              saveBrowserSettings({ sidebarShowTooltips: event.currentTarget.checked })
            }
          />
        </label>
      </div>
      <div className="settings-card-header sidebar-sections-heading">
        <h3 className="settings-card-title">Sidebar sections</h3>
      </div>
      <div className="settings-card">
        {ordered.map((section) => {
          const checked = settings.sidebarSections.includes(section);
          const index = ordered.indexOf(section);
          const move = (offset: -1 | 1) => {
            const next = moveSidebarSection(ordered, section, offset);
            let nextIndex = 0;
            saveBrowserSettings({
              sidebarSectionOrder: settings.sidebarSectionOrder.map((item) =>
                available.includes(item) ? next[nextIndex++] : item,
              ),
            });
          };
          return (
            <div key={section} className="settings-setting-row">
              <label htmlFor={`sidebar-section-${section}`} className="settings-setting-label">
                {SIDEBAR_SECTION_LABELS[section]}
              </label>
              <div className="sidebar-section-controls">
                <button
                  type="button"
                  className="theme-btn theme-btn-nav sidebar-settings-icon"
                  aria-label={`Move ${SIDEBAR_SECTION_LABELS[section]} up`}
                  disabled={index === 0}
                  onClick={() => move(-1)}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  type="button"
                  className="theme-btn theme-btn-nav sidebar-settings-icon"
                  aria-label={`Move ${SIDEBAR_SECTION_LABELS[section]} down`}
                  disabled={index === ordered.length - 1}
                  onClick={() => move(1)}
                >
                  <ArrowDown size={16} />
                </button>
                <input
                  id={`sidebar-section-${section}`}
                  type="checkbox"
                  className="settings-toggle"
                  checked={checked}
                  onChange={(event) =>
                    saveBrowserSettings({
                      sidebarSections: event.currentTarget.checked
                        ? [...settings.sidebarSections, section]
                        : settings.sidebarSections.filter((item) => item !== section),
                    })
                  }
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
