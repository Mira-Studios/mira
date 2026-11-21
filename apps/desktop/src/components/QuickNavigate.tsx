import { Globe, MoreHorizontal, Plus } from 'lucide-react';
import {
  openQuickNavigateEditor,
  showQuickNavigateMenu,
  useQuickLinks,
} from '../features/quickNavigate/quickNavigate';
import { useTabs } from '../features/tabs/TabsProvider';
import './QuickNavigate.css';

export default function QuickNavigate() {
  const links = useQuickLinks();
  const { navigate } = useTabs();
  return (
    <section className="quick-navigate" aria-label="Quick Navigate">
      <div className="quick-navigate-heading">
        <span>Quick Navigate</span>
        <button
          className="theme-btn theme-btn-nav"
          aria-label="Add Quick Navigate link"
          onClick={() => openQuickNavigateEditor()}
        >
          <Plus size={16} />
        </button>
      </div>
      <div className="quick-navigate-grid">
        {links.map((link) => (
          <div
            className="quick-navigate-card"
            key={link.id}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void showQuickNavigateMenu(event.clientX, event.clientY, link);
            }}
          >
            <button
              className="quick-navigate-link"
              title={link.url}
              onClick={() => navigate(link.url)}
            >
              <span className="quick-navigate-icon">
                {link.favicon ? <img src={link.favicon} alt="" /> : <Globe size={22} />}
              </span>
              <span className="quick-navigate-name">{link.name}</span>
            </button>
            <button
              className="theme-btn theme-btn-nav quick-navigate-more"
              aria-label={`Options for ${link.name}`}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                void showQuickNavigateMenu(rect.left, rect.bottom, link);
              }}
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
