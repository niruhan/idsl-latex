#import "config.typ": config
#set page(paper: "us-letter", margin: (left: 1.5in, right: 1in, top: 1in, bottom: 1in))
#set text(font: "Libertinus Serif", size: 12pt)
#set par(justify: true, leading: 1em)
#align(center)[
  #v(1in)
  #text(size: 20pt, weight: "bold", config.title)
  #v(1in)
  by \
  #config.author
  #v(1in)
  A thesis submitted in partial fulfillment of the requirements \
  for the degree of #config.degree \
  in #config.program
  #v(1fr)
  The School of Graduate and Postdoctoral Studies \
  Western University \
  London, Ontario, Canada \
  #config.year
]
#pagebreak()
#set page(numbering: "i")
#counter(page).update(2)
#include "front-matter.typ"
#pagebreak()
#outline(title: [Table of Contents])
#pagebreak()
#set page(numbering: "1")
#counter(page).update(1)
#set heading(numbering: "1.1")
#include "chapters/introduction.typ"
#pagebreak()
#include "chapters/methods.typ"
#pagebreak()
#bibliography("references.bib", style: "ieee")
#pagebreak()
#set heading(numbering: "A.1")
#counter(heading).update(0)
#include "appendices/appendix-a.typ"
