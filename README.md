# galon-precios

Precios semanales de combustibles de RD para la app Galón. Cada viernes en la tarde y sábado en la mañana,
GitHub lee la portada del MICM (micm.gob.do) y agrega la semana nueva a `prices.json` automáticamente.

- Correrlo a mano: pestaña **Actions** → "Actualizar precios de combustibles" → **Run workflow**.
- Si el MICM cambia su página y la lectura falla, GitHub te envía un correo y `prices.json` no se toca.
  Mientras se arregla, puedes editar `prices.json` aquí mismo con el lápiz.
- La app lee: https://raw.githubusercontent.com/Hillsantana/galon-precios/main/prices.json
