import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import DevToolsDock from '../../src/components/DevToolsDock';

function Fixture() {
  const [selected, setSelected] = useState(0);
  const guests = useRef<(HTMLElement & { getWebContentsId(): number })[]>([]);
  useEffect(() => {
    Object.assign(window, { selectTab: setSelected });
  }, []);
  return [0, 1].map((index) => (
    <div key={index} style={{
      display: 'flex', position: 'absolute', inset: '70px 0 0',
      visibility: selected === index ? 'visible' : 'hidden',
    }}>
      <webview src="about:blank" style={{ flex: 1, minWidth: 0 }} ref={(element) => {
        if (element) guests.current[index] = element as typeof guests.current[number];
      }} />
      <DevToolsDock active={selected === index} getWebContentsId={() => guests.current[index]?.getWebContentsId()} />
    </div>
  ));
}

createRoot(document.getElementById('root')!).render(<Fixture />);
