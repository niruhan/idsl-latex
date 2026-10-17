#set page(paper: "us-letter", margin: 1in, numbering: "1")
#set text(font: "Libertinus Serif", size: 11pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.")
#align(center)[
  #text(size: 20pt, weight: "bold")[Coursework Assignment]
  #v(0.5em)
  Course: EXAMPLE 101 · Assignment 1 \
  Student: Alex Student · Due: 1 November 2026
]
#v(1em)
= Expectations
Show your reasoning, state your assumptions, and explain the interpretation of
each result. Replace these example questions with your course material.
= Sample mean
Let $X_1, dots, X_n$ be independent variables with mean $mu$ and variance
$sigma^2$. Define $overline(X) = (1/n) sum_(i=1)^n X_i$.

*Solution.* Linearity of expectation gives $EE[overline(X)] = mu$.
Independence implies
$ op("Var")(overline(X)) = (1/n^2) sum_(i=1)^n op("Var")(X_i) = sigma^2/n. $

= A short proof
Prove that the average of two even integers is an integer.

*Proof.* Write the integers as $2a$ and $2b$, with $a,b in ZZ$.
Their average is $(2a+2b)/2 = a+b in ZZ$. #h(1fr) $square$

= Reflection
- Which assumptions did each solution require?
- What changes if the observations are correlated?
