---
title: Tolérance aux pannes et mise à l'échelle Kubernetes
summary: >-
  Un service Python conteneurisé sous HPA Kubernetes, soumis à des tests de charge
  pour vérifier qu'il s'adapte et se répare seul — 99 % de disponibilité, mesurée par Prometheus.
category: cloud
tech:
  - Kubernetes
  - Docker
  - Prometheus
  - Python
  - Bash
date: 2025-03-16
status: completed
featured: true
links:
  repo: https://github.com/moncef-bousselat/kubernetes-fault-tolerance
---

Une application Python sur des conteneurs Docker, orchestrée par Kubernetes avec
un Horizontal Pod Autoscaler visant 30 % d'utilisation CPU.

L'intérêt réside dans les tests plutôt que dans le déploiement. Des tests de
charge menés par des boucles cURL concurrentes ont suffisamment sollicité le
cluster pour déclencher les deux comportements qui méritaient d'être démontrés :
la mise à l'échelle sous charge, et le remplacement des pods tués en pleine
requête. Le système a maintenu 99 % de disponibilité sur ces exécutions.

Prometheus a collecté l'utilisation des ressources tout du long, ce qui
transforme « il a semblé récupérer » en une mesure.
