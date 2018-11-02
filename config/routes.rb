Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :partidos, only: [:index]
      resources :articles, only: [:index] do
          collection do
              get 'top_headlines_pt', to: 'articles#top_headlines'
              get 'all_news_pt', to: 'articles#all_news'
          end
      end
    end
  end
end
