import { Game } from './Game';

// Wait for DOM to be ready
window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
  const loading = document.getElementById('loading');

  if (!canvas) {
    console.error('Canvas element not found!');
    return;
  }

  // Initialize the game
  const game = new Game(canvas);

  game.initialize().then(() => {
    // Hide loading screen
    if (loading) {
      loading.classList.add('hidden');
      setTimeout(() => {
        loading.remove();
      }, 500);
    }

    // Start the render loop
    game.run();
  }).catch((error) => {
    console.error('Failed to initialize game:', error);
  });

  // Handle window resize
  window.addEventListener('resize', () => {
    game.resize();
  });
});
