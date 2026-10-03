/** Shapes whose outgoing meaning the bounded transfer reader cannot prove. */
export const unprovedHierarchyReferences = [
  '- [ ] Move [![photo](photo.png)](other.md)\n',
  '- [ ] Move [](other.md)\n',
  '- [ ] Move [label][id]\n\n[id]: https://example.com/original\n',
  '- [ ] Move [label][id]\n\n[id]: other.md\n',
  '- [ ] Move [id][]\n\n[id]: other.md\n',
  '- [ ] Move [id]\n\n[id]: other.md\n',
  '- [ ] Move\n    before `\n\n    ![photo](photo.png)\n\n    `\n',
  '- [ ] Move `soft\n  ![photo](photo.png)`\n',
];
