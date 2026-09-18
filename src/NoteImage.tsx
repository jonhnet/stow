import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Download, File, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { store, useStow } from './core/store';
import { isImageAttachment } from './core/images';
import type { Attachment } from './core/types';

type Lease = { url: string; release: () => void };

function fileDetails(attachment: Attachment) {
  const size = attachment.size < 1024 ? `${attachment.size} B` : attachment.size < 1024 * 1024 ? `${Math.ceil(attachment.size / 1024)} KB` : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;
  return `${attachment.type || 'File'} · ${size}`;
}

function OriginalAttachment({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const image = isImageAttachment(attachment);
  const [url, setUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let live = true;
    let lease: Lease | undefined;
    setUrl(undefined);
    setMessage(undefined);
    void store.originalUrl(attachment).then(result => {
      if (!live) { result?.release(); return; }
      lease = result;
      if (result) setUrl(result.url);
      else setMessage('This original is not saved on this device. Connect to download it.');
    }).catch(error => { if (live) setMessage(error instanceof Error ? error.message : 'Could not open this file.'); });
    return () => { live = false; lease?.release(); };
  }, [attachment.hash, attempt]);
  const keyDown = (event: KeyboardEvent) => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab') {
      const buttons = [...dialog.current!.querySelectorAll<HTMLElement>('button, a[href]')];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  return createPortal(<div className="image-viewer-backdrop" onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }} onPointerDown={event => event.stopPropagation()}>
    <div className={`image-viewer${image ? '' : 'attachment-viewer'}`} role="dialog" aria-modal="true" aria-label={`${image ? 'Original image' : 'Attachment'}: ${attachment.name}`} ref={dialog} onKeyDown={keyDown}>
      <div className="image-viewer-heading"><span>{attachment.name}</span><button className="icon-button" aria-label={image ? 'Close image' : 'Close attachment'} onClick={onClose}><X size={22} /></button></div>
      {url ? image ? <img src={url} alt={attachment.name} /> : <div className="original-image-message"><File size={36} /><p>{fileDetails(attachment)}</p><p>Download this file to open it in an app that supports its format.</p><a className="attachment-download" href={url} download={attachment.name}><Download size={18} />Download {attachment.name}</a></div> : message ? <div className="original-image-message"><p role="status">{message}</p><button className="text-button" onClick={() => setAttempt(value => value + 1)}>Try again</button></div> : <div className="original-image-message" role="status"><LoaderCircle className="spinning" size={24} />Opening original…</div>}
    </div>
  </div>, document.body);
}

type AttachmentProps = { attachment: Attachment; onRemove?: () => void; zoomable?: boolean };

function FileAttachment({ attachment, onRemove }: AttachmentProps) {
  const [viewing, setViewing] = useState(false);
  return <div className="note-image note-attachment">
    <button className="open-attachment" aria-label={`Open attachment: ${attachment.name}`} onClick={event => { event.stopPropagation(); setViewing(true); }}><File size={24} /><span>{attachment.name}<small>{fileDetails(attachment)}</small></span></button>
    {onRemove && <button type="button" className="icon-button remove-image" aria-label={`Remove ${attachment.name}`} onClick={event => { event.stopPropagation(); onRemove(); }}><X size={16} /></button>}
    {viewing && <OriginalAttachment attachment={attachment} onClose={() => setViewing(false)} />}
  </div>;
}

function ImagePreview({ attachment, onRemove, zoomable = true }: AttachmentProps) {
  const [url, setUrl] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [viewing, setViewing] = useState(false);
  const { status } = useStow();
  useEffect(() => {
    let live = true;
    let lease: Lease | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const retrieve = async () => {
      try {
        const result = await store.thumbnailUrl(attachment);
        if (!live) { result?.release(); return; }
        if (result) { lease = result; setUrl(result.url); setMessage(undefined); return; }
        setMessage(status === 'offline' ? 'Preview unavailable offline' : 'Preparing preview…');
      } catch (error) { if (live) setMessage(error instanceof Error ? error.message : 'Preview unavailable'); }
      if (live && status !== 'offline') timer = setTimeout(retrieve, 3000);
    };
    void retrieve();
    return () => { live = false; clearTimeout(timer); lease?.release(); };
  }, [attachment.hash, status]);
  const preview = url ? <img src={url} alt={attachment.name} loading="lazy" /> : <span className="image-placeholder"><ImagePlus size={24} /><span>{attachment.name}</span>{message && <small>{message}</small>}</span>;
  return <div className="note-image">
    {zoomable ? <button className="open-image" aria-label={`Open original: ${attachment.name}`} onClick={event => { event.stopPropagation(); setViewing(true); }}>{preview}</button> : <div className="open-image">{preview}</div>}
    {onRemove && <button type="button" className="icon-button remove-image" aria-label={`Remove ${attachment.name}`} onClick={event => { event.stopPropagation(); onRemove(); }}><X size={16} /></button>}
    {viewing && <OriginalAttachment attachment={attachment} onClose={() => setViewing(false)} />}
  </div>;
}

export default function NoteImage(props: AttachmentProps) {
  return isImageAttachment(props.attachment) ? <ImagePreview {...props} /> : <FileAttachment {...props} />;
}
