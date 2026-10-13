import { useEffect, useState } from 'react';
import { ContentText } from './content-text';

/**
 * The institution's logo with its name as the alt text, or just the name when there is no logo or it cannot be loaded.
 * Names can be Arabic or English, so the text picks its own direction; the image is contained, never stretched.
 */
export function InstitutionMark({ name, logoUrl, imgClassName = 'max-h-14 max-w-full', textClassName = '' }: {
  name: string | null; logoUrl: string | null | undefined; imgClassName?: string; textClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [logoUrl]);
  if (logoUrl && !failed) {
    return <img src={logoUrl} alt={name ?? ''} data-testid="institution-logo" className={`object-contain ${imgClassName}`} onError={() => setFailed(true)} />;
  }
  return name ? <ContentText className={textClassName}>{name}</ContentText> : null;
}
