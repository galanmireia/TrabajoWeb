async function loadBusinessInfo() {
  const res = await fetch('/api/business');
  const business = await res.json();

  const servicios = document.getElementById('servicios');
  business.servicios.forEach((s) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${s.nombre}</span><span>${s.precio}</span>`;
    servicios.appendChild(li);
  });

  document.getElementById('horario').textContent = `Hours: ${business.horario}`;
  document.getElementById('direccion').textContent = `Address: ${business.direccion}`;
}

loadBusinessInfo();
