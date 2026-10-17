#set page(paper: "us-letter", margin: (x: 0.9in, y: 0.8in))
#set text(font: "Libertinus Serif", size: 10.5pt)
#set par(leading: 0.5em)
#show heading.where(level: 1): it => block(width: 100%, above: 1em, below: 0.6em)[
  #text(size: 13pt, weight: "bold", fill: rgb("244b65"), it.body)
  #line(length: 100%, stroke: 0.4pt + rgb("b8c7d0"))
]
#align(center)[
  #text(size: 25pt, weight: "bold")[Alex Researcher]
  #v(0.4em)
  #link("mailto:author@example.test")[author\@example.test] · Example City \
  #link("https://example.com")[example.com]
]
= Research interests
Statistical learning, reliable experiments, and reproducible scientific software.
= Education
*Example University* #h(1fr) 2024–present \
Doctor of Philosophy, Computer Science \
Thesis: _A descriptive research title_

*Example Institute* #h(1fr) 2020–2024 \
Bachelor of Science, Mathematics
= Research experience
*Graduate Researcher · Example Laboratory* #h(1fr) 2024–present
- Developed reproducible baselines and documented evaluation assumptions.
- Collaborated on clear technical reports and open educational resources.
= Selected publications
+ Researcher, A., and Collaborator, B. _An example publication title._
  Example Workshop, 2026. Replace with your own publication record.
= Teaching and service
*Teaching Assistant · Introduction to Probability* #h(1fr) 2025–2026 \
Led tutorials, prepared examples, and provided feedback on assignments.
= Skills
*Programming:* Python, Julia, and scientific computing. \
*Writing:* Typst, LaTeX, and reproducible documentation.
