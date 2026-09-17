import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, RotateCcw } from 'lucide-react';
import { INSTALL_URL } from '../runtime';

export default function DemoNotice() {
  const [expanded, setExpanded] = useState(true);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const measure = () => document.documentElement.style.setProperty('--demo-notice-height', `${panel.current!.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(panel.current!); measure();
    return () => observer.disconnect();
  }, []);
  return <aside className="demo-notice" aria-label="Demo: edits are not saved" ref={panel}>
    <div className="demo-notice-bar">
      <button className="demo-notice-toggle" aria-expanded={expanded} aria-controls="demo-details" onClick={() => setExpanded(!expanded)}>
        <strong>DEMO</strong><span>Changes aren’t saved or synced</span>{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </button>
      <div className="demo-notice-actions"><button onClick={() => location.reload()}><RotateCcw size={15} />Start fresh</button><a href={INSTALL_URL} target="_blank" rel="noopener noreferrer">Install Stow<ExternalLink size={15} /></a></div>
    </div>
    {expanded && <div className="demo-details" id="demo-details">
      <p><strong>Keep your real notes elsewhere.</strong> Your edits live only in this tab. They are never saved on the server or synchronized. Reloading, closing the tab, or the browser discarding it loses your edits.</p>
      <p>Unavailable in this demo: image uploads, saved version history, device sync, and offline installation. The kitten photos are AI-generated samples. “Install Stow” opens the setup instructions on GitHub.</p>
    </div>}
  </aside>;
}
