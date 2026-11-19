let sequence = 0;
const normalize = value => value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\./g,'').replace(/[\s-]+/g,' ');

export function matchingSuggestions(choices, query) {
  const term = normalize(query);
  if (!term) return [];
  return [...new Set(choices)].filter(value => normalize(value).includes(term))
    .sort((a,b) => Number(normalize(b).startsWith(term)) - Number(normalize(a).startsWith(term)) || a.localeCompare(b))
    .slice(0,20);
}

export function attachSuggestions(form, name, choices) {
  const input = form.elements[name];
  const wrapper = document.createElement('div');
  wrapper.className = 'typeahead';
  input.replaceWith(wrapper);
  const list = document.createElement('div');
  list.id = 'suggestions-'+(++sequence);
  list.className = 'suggestions';
  list.setAttribute('role','listbox');
  list.setAttribute('aria-label',name === 'locality' ? 'Matching localities' : 'Matching brands');
  list.hidden = true;
  wrapper.append(input,list);
  input.autocomplete = 'off';
  input.setAttribute('role','combobox');
  input.setAttribute('aria-autocomplete','list');
  input.setAttribute('aria-controls',list.id);
  input.setAttribute('aria-expanded','false');
  let active = -1;
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }
  function choose(button) {
    input.value = button.textContent;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    close();
  }
  function show() {
    list.replaceChildren();
    active = -1;
    input.removeAttribute('aria-activedescendant');
    const matches = matchingSuggestions(choices,input.value);
    for (const [index,value] of matches.entries()) {
      const option = document.createElement('div');
      option.tabIndex = -1;
      option.id = list.id+'-'+index;
      option.setAttribute('role','option');
      option.setAttribute('aria-selected','false');
      option.textContent = value;
      option.onclick = () => choose(option);
      list.append(option);
    }
    list.hidden = !matches.length;
    input.setAttribute('aria-expanded',String(Boolean(matches.length)));
  }
  input.addEventListener('input',show);
  input.addEventListener('focus',show);
  list.addEventListener('pointerdown',event => event.preventDefault());
  wrapper.addEventListener('focusout',event => { if (!wrapper.contains(event.relatedTarget)) close(); });
  input.addEventListener('keydown',event => {
    if (event.key === 'Escape' && !list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === 'Tab') close();
    if (event.key === 'Enter' && active >= 0 && !list.hidden) {
      event.preventDefault();
      choose(list.children[active]);
      return;
    }
    if (!['ArrowDown','ArrowUp'].includes(event.key)) return;
    if (list.hidden) show();
    if (!list.children.length) return;
    event.preventDefault();
    if (active < 0) active = event.key === 'ArrowDown' ? 0 : list.children.length-1;
    else active = (active + (event.key === 'ArrowDown' ? 1 : -1) + list.children.length) % list.children.length;
    for (const [index,option] of [...list.children].entries()) option.setAttribute('aria-selected',String(index === active));
    const option = list.children[active];
    input.setAttribute('aria-activedescendant',option.id);
    option.scrollIntoView({block:'nearest'});
  });
}
