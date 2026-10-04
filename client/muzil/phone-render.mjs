// Patch around live editors. Updating a timer, thread or alert must not detach them.
export function patchPhoneScreen(root, key, html, {editing = false} = {}) {
  if(root.dataset.screen!==key){root.innerHTML=html;root.dataset.screen=key;return;}
  const template=root.ownerDocument.createElement('template');template.innerHTML=html;
  function sync(parent, desired) {
    const fresh=[...desired.childNodes];
    for(let i=0;i<fresh.length;i++){
      const next=fresh[i],old=parent.childNodes[i];
      if(!old){parent.appendChild(next.cloneNode(true));continue;}
      if(old.nodeType!==next.nodeType || old.nodeName!==next.nodeName){old.replaceWith(next.cloneNode(true));continue;}
      if(old.nodeType===3){if(old.data!==next.data)old.data=next.data;continue;}
      if(old.nodeType!==1)continue;
      for(const attr of [...old.attributes])if(!next.hasAttribute(attr.name))old.removeAttribute(attr.name);
      for(const attr of [...next.attributes])if(old.getAttribute(attr.name)!==attr.value)old.setAttribute(attr.name,attr.value);
      if(old.matches('textarea,input')){
        if(!editing && old.value!==next.value)old.value=next.value;
        continue;
      }
      sync(old,next);
    }
    while(parent.childNodes.length>fresh.length)parent.lastChild.remove();
  }
  sync(root,template.content);
}
