import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
} from 'docx';
import { NarrativeResult, ShortFormClip } from './types';

function headerCell(text: string): TableCell {
  return new TableCell({
    width: { size: 12, type: WidthType.PERCENTAGE },
    shading: { fill: 'D9D9D9' },
    children: [
      new Paragraph({ children: [new TextRun({ text, bold: true })] }),
    ],
  });
}

function bodyCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: text || '-' })] })],
  });
}

const NO_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  left: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
  right: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
};

export interface DocxExportOptions {
  sourceFileName: string;
  narrative: NarrativeResult;
  clips: ShortFormClip[];
  generatedAt: Date;
}

export async function buildNarrativeDocx(opts: DocxExportOptions): Promise<Buffer> {
  const { narrative, clips, sourceFileName, generatedAt } = opts;

  const children: (Paragraph | Table)[] = [];

  // --- Title block ---
  children.push(
    new Paragraph({
      text: narrative.title,
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      children: [new TextRun({ text: narrative.logline, italics: true })],
    }),
    new Paragraph({
      children: [
        new TextRun({
          text: `Source footage: ${sourceFileName}`,
          size: 18,
          color: '666666',
        }),
      ],
    }),
    ...(narrative.titleOptions && narrative.titleOptions.length > 1
      ? [
          new Paragraph({
            children: [
              new TextRun({
                text: `Other title options: ${narrative.titleOptions.slice(1).join(' / ')}`,
                size: 18,
                color: '666666',
              }),
            ],
          }),
        ]
      : []),
    new Paragraph({
      children: [
        new TextRun({
          text: `Generated ${generatedAt.toISOString().slice(0, 10)}`,
          size: 18,
          color: '666666',
        }),
      ],
    }),
    new Paragraph({ text: '' })
  );

  if (narrative.themes && narrative.themes.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: 'Themes: ', bold: true }),
          new TextRun({ text: narrative.themes.join(', ') }),
        ],
      }),
      new Paragraph({ text: '' })
    );
  }

  // --- Long-form narrative outline ---
  children.push(
    new Paragraph({ text: 'Long-Form Narrative Outline', heading: HeadingLevel.HEADING_1 })
  );

  for (const section of narrative.sections) {
    children.push(
      new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_2 }),
      new Paragraph({ children: [new TextRun({ text: section.narrative })] })
    );

    if (section.citations && section.citations.length > 0) {
      const citationText = section.citations
        .map((c) => (c.quote ? `${c.timestamp} ("${c.quote}")` : c.timestamp))
        .join('; ');
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Timestamps: ', bold: true, size: 20 }),
            new TextRun({ text: citationText, size: 20, color: '444444' }),
          ],
        })
      );
    }
    children.push(new Paragraph({ text: '' }));
  }

  if (narrative.closingLine) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: narrative.closingLine, italics: true })],
      }),
      new Paragraph({ text: '' })
    );
  }

  // --- Short-form picks ---
  children.push(
    new Paragraph({ text: 'Short-Form Picks', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({
      children: [
        new TextRun({
          text: `${clips.length} self-contained moment${clips.length === 1 ? '' : 's'} flagged for social. In/out timestamps match the accompanying .fcpxml timeline.`,
        }),
      ],
    }),
    new Paragraph({ text: '' })
  );

  if (clips.length > 0) {
    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        headerCell('#'),
        headerCell('Title'),
        headerCell('In'),
        headerCell('Out'),
        headerCell('Dur (s)'),
        headerCell('Hook / Idea / Payoff'),
        headerCell('Rationale'),
        headerCell('Caption & Platforms'),
      ],
    });

    const rows = clips.map((clip, i) => {
      const duration = Math.round(clip.endSec - clip.startSec);
      const hookIdeaPayoff = `Hook: ${clip.hook}\nIdea: ${clip.singleIdea}\nPayoff: ${clip.payoff}`;
      const captionPlatforms = [
        clip.suggestedCaption ? `"${clip.suggestedCaption}"` : '',
        clip.platformFit && clip.platformFit.length > 0
          ? `[${clip.platformFit.join(', ')}]`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      return new TableRow({
        children: [
          bodyCell(String(i + 1)),
          bodyCell(clip.title),
          bodyCell(clip.startTimestamp),
          bodyCell(clip.endTimestamp),
          bodyCell(String(duration)),
          bodyCell(hookIdeaPayoff),
          bodyCell(clip.rationale),
          bodyCell(captionPlatforms),
        ],
      });
    });

    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: NO_BORDER,
        rows: [headerRow, ...rows],
      })
    );
  } else {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'No self-contained 15-60s moments were flagged in this footage.', italics: true })],
      })
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return Packer.toBuffer(doc);
}
