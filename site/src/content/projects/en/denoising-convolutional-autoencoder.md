---
title: Denoising convolutional autoencoder
summary: >-
  A convolutional autoencoder whose decoder is trained to strip noise out of its
  input rather than just reconstruct it. Built during the Ericsson internship.
category: data-ai
tech:
  - Python
  - PyTorch
  - Matplotlib
date: 2022-12-25
status: archived
links:
  repo: https://github.com/moncef-bousselat/denoising_convolutional_autoencoder
---

Designed as part of my Ericsson internship on deep learning in IoT networking.

The network is a convolutional autoencoder, with the decoder trained to remove
noise from the input rather than reproduce it faithfully — so the reconstruction
target is the clean signal, not the signal it was given.
