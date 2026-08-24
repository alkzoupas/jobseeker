% cover.cls — pdflatex-compatible cover letter class
% Matches the CV aesthetic (TeX Gyre Heros, clean sans-serif, dark professional look)
% Adapted from MadsLorentzen/ai-job-search cover.cls structure
%
% Compile with: pdflatex cover_<company>_<role>.tex

\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{cover}[2026/08/24 Cover letter class matching trust_resume.tex style]

\LoadClass[10pt,letterpaper]{article}

\RequirePackage[utf8]{inputenc}
\RequirePackage[T1]{fontenc}
\RequirePackage{lmodern}
\RequirePackage{textcomp}
\RequirePackage[margin=0.8in]{geometry}
\RequirePackage[hidelinks]{hyperref}
\RequirePackage{xcolor}
\RequirePackage{titlesec}
\RequirePackage{parskip}
\RequirePackage[none]{hyphenat}
\RequirePackage{enumitem}
\RequirePackage{tgheros}

\sloppy
\renewcommand{\familydefault}{\sfdefault}
\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlength{\parskip}{8pt}
\setlist[itemize]{leftmargin=1.2em, itemsep=2pt, topsep=2pt}

% Colors matching CV style
\definecolor{headingcolor}{HTML}{333333}
\definecolor{subcolor}{HTML}{666666}

% --- Cover letter commands ---

% \namesection{Name}{Subtitle}{Contact info}
\newcommand{\namesection}[3]{%
  \begin{center}
    {\LARGE \textbf{\textcolor{headingcolor}{#1}}}\\[4pt]
    {\large \textcolor{subcolor}{#2}}\\[2pt]
    {\small #3}
  \end{center}
  \vspace{4pt}
  \noindent\rule{\textwidth}{0.4pt}
  \vspace{8pt}
}

% \currentdate{date text}
\newcommand{\currentdate}[1]{%
  \begin{flushright}
    \textcolor{subcolor}{#1}
  \end{flushright}
  \vspace{-4pt}
}

% \recipient{Name or "Hiring Manager"}{Company}{Address (optional)}
\newcommand{\recipient}[3]{%
  \noindent #1\\
  \textbf{#2}\\
  #3
  \vspace{8pt}
}

% \lettercontent{paragraph text}
\newcommand{\lettercontent}[1]{%
  \noindent #1\par
}

% \closing{text}
\newcommand{\closing}[1]{%
  \vspace{12pt}
  \noindent #1\\
}

% \signature{name}
\newcommand{\signature}[1]{%
  \vspace{4pt}
  \noindent \textbf{#1}
}
