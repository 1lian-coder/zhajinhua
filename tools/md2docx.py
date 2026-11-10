# -*- coding: utf-8 -*-
"""把 Markdown 文档转成带样式的 Word 文档（零依赖 python-docx）"""
import re
import sys
from docx import Document
from docx.shared import Pt, RGBColor, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement


def set_cell_bg(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), color)
    tcPr.append(shd)


def add_mono(par, text):
    run = par.add_run(text)
    run.font.name = 'Consolas'
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x1F, 0x3A, 0x2E)
    return run


def parse_blocks(md):
    """把 markdown 切成块：heading / table / code / list / paragraph"""
    lines = md.split('\n')
    blocks = []
    i = 0
    while i < len(lines):
        line = lines[i]
        s = line.strip()

        # 跳过空行
        if not s:
            i += 1
            continue

        # 分隔线
        if re.match(r'^---+$', s):
            blocks.append(('hr', ''))
            i += 1
            continue

        # 标题
        m = re.match(r'^(\#+)\s+(.*)$', s)
        if m:
            blocks.append(('h', (len(m.group(1)), m.group(2).strip())))
            i += 1
            continue

        # 代码块
        if s.startswith('```'):
            i += 1
            code = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                code.append(lines[i])
                i += 1
            i += 1
            blocks.append(('code', '\n'.join(code)))
            continue

        # 表格（连续以 | 开头的行）
        if s.startswith('|'):
            rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                rows.append(lines[i].strip())
                i += 1
            blocks.append(('table', rows))
            continue

        # 列表
        if re.match(r'^[-*]\s+', s) or re.match(r'^\d+\.\s+', s):
            items = []
            while i < len(lines):
                ls = lines[i].strip()
                if re.match(r'^[-*]\s+', ls) or re.match(r'^\d+\.\s+', ls):
                    items.append(ls)
                    i += 1
                elif ls.startswith('```'):
                    break
                elif ls.startswith('|'):
                    break
                elif re.match(r'^(\#+)\s+', ls) or not ls:
                    break
                else:
                    # 续行
                    if items:
                        items[-1] += ' ' + ls
                    i += 1
            blocks.append(('list', items))
            continue

        # 普通段落（合并到空行或下一块）
        paras = []
        while i < len(lines):
            ls = lines[i].strip()
            if not ls or ls.startswith('```') or ls.startswith('|') or re.match(r'^(\#+)\s+', ls):
                break
            paras.append(ls)
            i += 1
        blocks.append(('p', ' '.join(paras)))
    return blocks


def strip_inline(text):
    """去掉 markdown 行内标记，返回 [(文本, 是否粗体, 是否代码)] 片段"""
    parts = []
    # 先处理 `code`
    tokens = re.split(r'(`[^`]*`|\*\*[^*]*\*\*)', text)
    for tok in tokens:
        if not tok:
            continue
        if tok.startswith('`') and tok.endswith('`') and len(tok) > 2:
            parts.append((tok[1:-1], False, True))
        elif tok.startswith('**') and tok.endswith('**') and len(tok) > 4:
            parts.append((tok[2:-2], True, False))
        else:
            parts.append((tok, False, False))
    return parts


def add_rich(par, text, base_size=10.5):
    for seg, bold, mono in strip_inline(text):
        run = par.add_run(seg)
        if mono:
            run.font.name = 'Consolas'
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor(0x1F, 0x3A, 0x2E)
            run.font.bold = bold
        else:
            run.font.size = Pt(base_size)
            run.font.bold = bold


def build(md_path, out_path):
    with open(md_path, 'r', encoding='utf-8') as f:
        md = f.read()

    doc = Document()

    # 页面设置
    for section in doc.sections:
        section.top_margin = Cm(2)
        section.bottom_margin = Cm(2)
        section.left_margin = Cm(2.2)
        section.right_margin = Cm(2.2)

    # 正文默认字体
    style = doc.styles['Normal']
    style.font.name = '微软雅黑'
    style.font.size = Pt(10.5)
    style.paragraph_format.space_after = Pt(4)
    style.paragraph_format.line_spacing = 1.25

    blocks = parse_blocks(md)

    for kind, payload in blocks:
        if kind == 'h':
            level, text = payload
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(14 if level <= 2 else 10)
            p.paragraph_format.space_after = Pt(6)
            run = p.add_run(text)
            run.font.name = '微软雅黑'
            run.font.bold = True
            run.font.size = Pt(18 if level == 1 else (15 if level == 2 else 12.5))
            run.font.color.rgb = RGBColor(0x1B, 0x3A, 0x5C) if level <= 2 else RGBColor(0x33, 0x44, 0x55)
            # 中文标题加下划线条
            if level == 2:
                pPr = p._p.get_or_add_pPr()
                pbdr = OxmlElement('w:pBdr')
                bottom = OxmlElement('w:bottom')
                bottom.set(qn('w:val'), 'single')
                bottom.set(qn('w:sz'), '6')
                bottom.set(qn('w:space'), '3')
                bottom.set(qn('w:color'), 'AAB8C4')
                pbdr.append(bottom)
                pPr.append(pbdr)

        elif kind == 'code':
            # 用单格表格做代码块底色
            t = doc.add_table(rows=1, cols=1)
            t.alignment = WD_TABLE_ALIGNMENT.CENTER
            cell = t.cell(0, 0)
            set_cell_bg(cell, 'F4F6F4')
            cell.paragraphs[0].text = ''
            first = True
            for ln in payload.split('\n'):
                par = cell.paragraphs[0] if first else cell.add_paragraph()
                first = False
                par.paragraph_format.space_after = Pt(0)
                par.paragraph_format.line_spacing = 1.1
                add_mono(par, ln if ln else ' ', Pt(8.5) if False else None) if False else add_mono(par, ln if ln else '')
            # 表格边框
            tbl = t._tbl
            tblPr = tbl.tblPr
            borders = OxmlElement('w:tblBorders')
            for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
                el = OxmlElement('w:' + edge)
                el.set(qn('w:val'), 'single')
                el.set(qn('w:sz'), '4')
                el.set(qn('w:space'), '0')
                el.set(qn('w:color'), 'D8DEE2')
                borders.append(el)
            tblPr.append(borders)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)

        elif kind == 'table':
            rows = payload
            # 去掉分隔行 |---|---|
            clean = [r for r in rows if not re.match(r'^\|[-:\s|]+\|$', r)]
            if not clean:
                continue
            cells = []
            for r in clean:
                parts = [c.strip() for c in r.strip('|').split('|')]
                cells.append(parts)
            ncol = max(len(x) for x in cells)
            t = doc.add_table(rows=len(cells), cols=ncol)
            t.alignment = WD_TABLE_ALIGNMENT.CENTER
            tbl = t._tbl
            tblPr = tbl.tblPr
            borders = OxmlElement('w:tblBorders')
            for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
                el = OxmlElement('w:' + edge)
                el.set(qn('w:val'), 'single')
                el.set(qn('w:sz'), '4')
                el.set(qn('w:space'), '0')
                el.set(qn('w:color'), 'C9D2D9')
                borders.append(el)
            tblPr.append(borders)
            for ri, row in enumerate(cells):
                for ci in range(ncol):
                    cell = t.cell(ri, ci)
                    cell.text = ''
                    par = cell.paragraphs[0]
                    par.paragraph_format.space_after = Pt(0)
                    txt = row[ci] if ci < len(row) else ''
                    if ri == 0:
                        set_cell_bg(cell, 'E8EEF3')
                        add_run_bold = par.add_run(txt.replace('**', ''))
                        add_run_bold.font.bold = True
                        add_run_bold.font.size = Pt(9.5)
                        add_run_bold.font.name = '微软雅黑'
                    else:
                        add_rich(par, txt, base_size=9.5)
            doc.add_paragraph().paragraph_format.space_after = Pt(2)

        elif kind == 'list':
            for item in payload:
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Cm(0.6)
                p.paragraph_format.space_after = Pt(2)
                m = re.match(r'^\d+\.\s+', item)
                prefix = ''
                body = item
                if m:
                    prefix = m.group(0).strip() + ' '
                    body = item[m.end():]
                else:
                    body = re.sub(r'^[-*]\s+', '', item)
                    prefix = '• '
                run = p.add_run(prefix)
                run.font.size = Pt(10)
                run.font.bold = True
                add_rich(p, body, base_size=10)

        elif kind == 'p':
            # 跳过纯空
            if not payload.strip():
                continue
            p = doc.add_paragraph()
            add_rich(p, payload, base_size=10.5)

        elif kind == 'hr':
            p = doc.add_paragraph()
            pPr = p._p.get_or_add_pPr()
            pbdr = OxmlElement('w:pBdr')
            bottom = OxmlElement('w:bottom')
            bottom.set(qn('w:val'), 'single')
            bottom.set(qn('w:sz'), '6')
            bottom.set(qn('w:space'), '1')
            bottom.set(qn('w:color'), 'D0D7DE')
            pbdr.append(bottom)
            pPr.append(pbdr)

    doc.save(out_path)
    print('已生成:', out_path)


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
