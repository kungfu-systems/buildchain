.PHONY: check pdf clean

check:
	@test -f paper/main.tex
	@test -f paper/references.bib
	@git diff --check

pdf:
	mkdir -p _build
	printf '%s\n' '%PDF-1.4 fixture' > _build/main.pdf

clean:
	rm -rf _build
