import { readFileSync } from 'fs';

interface ParseResult {
  type: 'image' | 'document' | 'data';
  content: string;
  preview?: string;
  metadata: {
    size: number;
    pages?: number;
  };
}

export async function parseFile(buffer: Buffer, mimeType: string, fileName: string): Promise<ParseResult> {
  const size = buffer.length;

  // Images
  if (mimeType.startsWith('image/')) {
    return {
      type: 'image',
      content: '',
      preview: `data:${mimeType};base64,${buffer.toString('base64')}`,
      metadata: { size },
    };
  }

  // PDF
  if (mimeType === 'application/pdf') {
    try {
      const pdfParse = (await import('pdf-parse')).default;
      const result = await pdfParse(buffer);
      return {
        type: 'document',
        content: result.text,
        metadata: { size, pages: result.numpages },
      };
    } catch {
      return { type: 'document', content: '[Failed to parse PDF]', metadata: { size } };
    }
  }

  // Word
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return { type: 'document', content: result.value, metadata: { size } };
    } catch {
      return { type: 'document', content: '[Failed to parse Word document]', metadata: { size } };
    }
  }

  // JSON
  if (mimeType === 'application/json' || fileName.endsWith('.json')) {
    try {
      const text = buffer.toString('utf-8');
      const parsed = JSON.parse(text);
      return { type: 'data', content: JSON.stringify(parsed, null, 2), metadata: { size } };
    } catch {
      return { type: 'data', content: buffer.toString('utf-8'), metadata: { size } };
    }
  }

  // YAML
  if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
    return { type: 'data', content: buffer.toString('utf-8'), metadata: { size } };
  }

  // Text/Markdown/CSV and other text files
  if (mimeType.startsWith('text/') || fileName.endsWith('.md') || fileName.endsWith('.csv') || fileName.endsWith('.txt')) {
    return { type: 'document', content: buffer.toString('utf-8'), metadata: { size } };
  }

  // Fallback
  return { type: 'document', content: buffer.toString('utf-8'), metadata: { size } };
}
