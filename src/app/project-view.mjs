/** A registered project has an identity, never an inferred delivery or learning stage. */
export function projectCards(registry,confirmedProjects) {
  const entries=[...(registry?.code_projects??[]),...(registry?.knowledge_projects??[])];
  const cards=entries.map(entry=>({id:entry.id,name:entry.name,route_type:entry.route_type,registry_status:entry.status??null,kind:'project',goal:null,stage:null,blocker:null,next_step:null,evidence:null,confirmed:false,confirmed_at:null}));
  for(const project of confirmedProjects) {
    const index=cards.findIndex(card=>card.id===project.id);
    const card={...(index<0?{name:project.id,route_type:null,registry_status:null}:cards[index]),...structuredClone(project)};
    if(index<0)cards.push(card);else cards[index]=card;
  }
  return cards;
}
