# Infra Contract Shaped Fixture

This fixture models an infrastructure repository that already has live resources
and wants to publish observed output contracts before full IaC ownership exists.

It proves that `project.type = "infra-contract"` can validate desired files,
read reviewed observed outputs, publish a deterministic contract artifact, and
plan downstream consumer pull requests without mutating cloud infrastructure.
